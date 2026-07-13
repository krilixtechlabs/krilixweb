const crypto = require("crypto");

const ROLE_DEFINITIONS = {
  owner: {
    label: "Tulajdonos",
    description: "Teljes hozzáférés, fiókok és jogosultságok kezelése.",
    permissions: [
      "briefs.read",
      "briefs.write",
      "briefs.delete",
      "messages.read",
      "messages.write",
      "messages.reply",
      "messages.delete",
      "projects.read",
      "projects.write",
      "customers.read",
      "customers.write",
      "settings.manage",
      "users.manage",
      "audit.read"
    ]
  },
  admin: {
    label: "Adminisztrátor",
    description: "Napi adminisztráció, briefek, üzenetek és ügyféladatok kezelése.",
    permissions: [
      "briefs.read",
      "briefs.write",
      "briefs.delete",
      "messages.read",
      "messages.write",
      "messages.reply",
      "messages.delete",
      "projects.read",
      "projects.write",
      "customers.read",
      "customers.write",
      "settings.manage",
      "audit.read"
    ]
  },
  project_manager: {
    label: "Projektmenedzser",
    description: "Briefek, ügyfélkommunikáció és projektek kezelése törlési jog nélkül.",
    permissions: [
      "briefs.read",
      "briefs.write",
      "messages.read",
      "messages.write",
      "messages.reply",
      "projects.read",
      "projects.write",
      "customers.read",
      "customers.write"
    ]
  },
  sales: {
    label: "Értékesítés",
    description: "Érdeklődők, briefek, ajánlatkérések és ügyfélkapcsolatok kezelése.",
    permissions: [
      "briefs.read",
      "briefs.write",
      "messages.read",
      "messages.write",
      "messages.reply",
      "customers.read",
      "customers.write"
    ]
  },
  developer: {
    label: "Fejlesztő",
    description: "Projektek és technikai információk megtekintése, projektadatok kezelése.",
    permissions: [
      "briefs.read",
      "messages.read",
      "projects.read",
      "projects.write",
      "customers.read"
    ]
  },
  viewer: {
    label: "Megtekintő",
    description: "Csak olvasási hozzáférés, módosítás és törlés nélkül.",
    permissions: [
      "briefs.read",
      "messages.read",
      "projects.read",
      "customers.read"
    ]
  }
};

const PERMISSION_DEFINITIONS = {
  "briefs.read": { label: "Briefek megtekintése", group: "Briefek" },
  "briefs.write": { label: "Briefek módosítása", group: "Briefek" },
  "briefs.delete": { label: "Briefek törlése", group: "Briefek" },
  "messages.read": { label: "Ajánlatkérések megtekintése", group: "Üzenetek" },
  "messages.write": { label: "Ajánlatkérések állapotának módosítása", group: "Üzenetek" },
  "messages.reply": { label: "Válasz küldése ügyfeleknek", group: "Üzenetek" },
  "messages.delete": { label: "Ajánlatkérések törlése", group: "Üzenetek" },
  "projects.read": { label: "Projektek megtekintése", group: "Projektek" },
  "projects.write": { label: "Projektek kezelése", group: "Projektek" },
  "customers.read": { label: "Ügyfelek megtekintése", group: "Ügyfelek" },
  "customers.write": { label: "Ügyfelek kezelése", group: "Ügyfelek" },
  "settings.manage": { label: "Rendszerbeállítások kezelése", group: "Rendszer" },
  "users.manage": { label: "Fiókok és jogosultságok kezelése", group: "Rendszer" },
  "audit.read": { label: "Tevékenységnapló megtekintése", group: "Rendszer" }
};

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 7;

function createAdminAuth({ pool, cookieName = "krilix_admin" }) {
  const loginAttempts = new Map();
  let initPromise = null;

  function init() {
    if (!initPromise) initPromise = initializeTables();
    return initPromise;
  }

  async function initializeTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        permission_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
        last_login_at TIMESTAMP,
        created_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id BIGSERIAL PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL,
        last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_address TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS admin_user_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL;`).catch(() => {});
    await pool.query(`ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS sender_name TEXT;`).catch(() => {});

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_unique ON admin_users (LOWER(email));`);
    await pool.query(`CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_log(created_at DESC);`);

    await pool.query(`DELETE FROM admin_sessions WHERE expires_at <= NOW();`);

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM admin_users`);
    if ((countResult.rows[0]?.count || 0) === 0) {
      const bootstrapPassword = String(process.env.ADMIN_PASSWORD || "");
      const bootstrapEmail = normalizeEmail(
        process.env.ADMIN_EMAIL || process.env.CONTACT_TO_EMAIL || "hello@krilixtechlabs.com"
      );
      const bootstrapName = cleanText(process.env.ADMIN_NAME || "Krilix Tulajdonos", 120);

      if (!bootstrapPassword) {
        throw new Error("Az első tulajdonosi fiók létrehozásához hiányzik az ADMIN_PASSWORD környezeti változó.");
      }
      if (!isValidEmail(bootstrapEmail)) {
        throw new Error("Az ADMIN_EMAIL vagy CONTACT_TO_EMAIL nem tartalmaz érvényes email címet.");
      }

      const passwordHash = await hashPassword(bootstrapPassword);
      const mustChangePassword = bootstrapPassword.length < PASSWORD_MIN_LENGTH;
      await pool.query(
        `
        INSERT INTO admin_users
          (name, email, password_hash, role, is_active, must_change_password)
        VALUES ($1, $2, $3, 'owner', TRUE, $4)
        `,
        [bootstrapName, bootstrapEmail, passwordHash, mustChangePassword]
      );
      console.log(`Első Krilix admin fiók létrehozva: ${bootstrapEmail}`);
      if (mustChangePassword) {
        console.warn(`Az induló ADMIN_PASSWORD rövidebb ${PASSWORD_MIN_LENGTH} karakternél, ezért az első belépéskor kötelező jelszócsere történik.`);
      }
    }
  }

  function mountRoutes(app) {
    const safe = (handler) => (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch(next);
    };

    app.get("/api/admin/me", requireAuth, safe(async (req, res) => {
      return res.status(200).json({ ok: true, user: publicUser(req.adminUser) });
    }));

    app.get("/api/admin/auth-meta", requireAuth, (req, res) => {
      return res.status(200).json({
        ok: true,
        roles: publicRoleDefinitions(),
        permissions: PERMISSION_DEFINITIONS
      });
    });

    app.post("/api/admin/login", safe(async (req, res) => {
      await init();
      const email = normalizeEmail(req.body?.email || "");
      const password = String(req.body?.password || "");
      const attemptKey = `${clientIp(req)}:${email}`;

      if (isRateLimited(attemptKey)) {
        return res.status(429).json({
          ok: false,
          error: "Túl sok sikertelen próbálkozás. Próbáld újra később."
        });
      }

      if (!email || !password) {
        registerFailedAttempt(attemptKey);
        return res.status(400).json({ ok: false, error: "Email cím és jelszó szükséges." });
      }
      if (password.length > 256) {
        registerFailedAttempt(attemptKey);
        return res.status(400).json({ ok: false, error: "A jelszó túl hosszú." });
      }

      const result = await pool.query(`SELECT * FROM admin_users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email]);
      const user = result.rows[0];
      const passwordValid = user ? await verifyPassword(password, user.password_hash) : false;

      if (!user || !passwordValid || !user.is_active) {
        registerFailedAttempt(attemptKey);
        await logAuditRaw(null, "auth.login_failed", "admin_user", user?.id || null, { email }, req);
        return res.status(401).json({ ok: false, error: "Hibás email cím vagy jelszó." });
      }

      clearAttempts(attemptKey);

      const rawToken = crypto.randomBytes(48).toString("base64url");
      const tokenHash = hashSessionToken(rawToken);
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);

      await pool.query(
        `
        INSERT INTO admin_sessions
          (token_hash, user_id, expires_at, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [tokenHash, user.id, expiresAt, clientIp(req), cleanText(req.headers["user-agent"] || "", 500)]
      );

      await pool.query(`UPDATE admin_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`, [user.id]);

      setSessionCookie(res, req, rawToken, Math.floor(SESSION_MAX_AGE_MS / 1000));
      await logAuditRaw(user.id, "auth.login", "admin_user", user.id, {}, req);

      const refreshedUser = await findUserById(user.id);
      return res.status(200).json({ ok: true, user: publicUser(refreshedUser) });
    }));

    app.post("/api/admin/logout", requireAuth, safe(async (req, res) => {
      await pool.query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [req.adminSession.tokenHash]);
      clearSessionCookie(res, req);
      await logAudit(req, "auth.logout", "admin_user", req.adminUser.id);
      return res.status(200).json({ ok: true });
    }));

    app.post("/api/admin/change-password", requireAuth, safe(async (req, res) => {
      const currentPassword = String(req.body?.currentPassword || "");
      const newPassword = String(req.body?.newPassword || "");

      if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > 256) {
        return res.status(400).json({
          ok: false,
          error: `Az új jelszó ${PASSWORD_MIN_LENGTH} és 256 karakter közötti legyen.`
        });
      }

      const currentUser = await findUserById(req.adminUser.id, true);
      if (!currentUser || !(await verifyPassword(currentPassword, currentUser.password_hash))) {
        return res.status(401).json({ ok: false, error: "A jelenlegi jelszó hibás." });
      }

      if (await verifyPassword(newPassword, currentUser.password_hash)) {
        return res.status(400).json({ ok: false, error: "Az új jelszó nem egyezhet meg a régivel." });
      }

      const passwordHash = await hashPassword(newPassword);
      await pool.query(
        `
        UPDATE admin_users
        SET password_hash = $1, must_change_password = FALSE, updated_at = NOW()
        WHERE id = $2
        `,
        [passwordHash, req.adminUser.id]
      );

      await pool.query(
        `DELETE FROM admin_sessions WHERE user_id = $1 AND token_hash <> $2`,
        [req.adminUser.id, req.adminSession.tokenHash]
      );

      await logAudit(req, "auth.password_changed", "admin_user", req.adminUser.id);
      return res.status(200).json({ ok: true });
    }));

    app.get("/api/admin/users", requirePermission("users.manage"), safe(async (req, res) => {
      const result = await pool.query(`
        SELECT id, name, email, role, permission_overrides, is_active,
               must_change_password, last_login_at, created_at, updated_at
        FROM admin_users
        ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, name ASC
      `);

      return res.status(200).json({
        ok: true,
        users: result.rows.map(publicUser)
      });
    }));

    app.post("/api/admin/users", requirePermission("users.manage"), safe(async (req, res) => {
      const name = cleanText(req.body?.name, 120);
      const email = normalizeEmail(req.body?.email || "");
      const role = String(req.body?.role || "viewer");
      const password = String(req.body?.password || "");
      const permissionOverrides = normalizePermissionOverrides(req.body?.permissionOverrides);

      if (!name || !email || !isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: "Érvényes név és email cím szükséges." });
      }
      if (!ROLE_DEFINITIONS[role]) {
        return res.status(400).json({ ok: false, error: "Érvénytelen szerepkör." });
      }
      if (role === "owner" && req.adminUser.role !== "owner") {
        return res.status(403).json({ ok: false, error: "Tulajdonosi fiókot csak tulajdonos hozhat létre." });
      }
      if (password.length < PASSWORD_MIN_LENGTH || password.length > 256) {
        return res.status(400).json({
          ok: false,
          error: `Az ideiglenes jelszó ${PASSWORD_MIN_LENGTH} és 256 karakter közötti legyen.`
        });
      }

      try {
        const passwordHash = await hashPassword(password);
        const result = await pool.query(
          `
          INSERT INTO admin_users
            (name, email, password_hash, role, permission_overrides, is_active,
             must_change_password, created_by)
          VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, TRUE, $6)
          RETURNING id, name, email, role, permission_overrides, is_active,
                    must_change_password, last_login_at, created_at, updated_at
          `,
          [name, email, passwordHash, role, JSON.stringify(permissionOverrides), req.adminUser.id]
        );

        await logAudit(req, "user.created", "admin_user", result.rows[0].id, {
          email,
          role
        });

        return res.status(201).json({ ok: true, user: publicUser(result.rows[0]) });
      } catch (error) {
        if (error?.code === "23505") {
          return res.status(409).json({ ok: false, error: "Ezzel az email címmel már létezik fiók." });
        }
        throw error;
      }
    }));

    app.patch("/api/admin/users/:id", requirePermission("users.manage"), safe(async (req, res) => {
      const userId = Number(req.params.id);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ ok: false, error: "Érvénytelen felhasználó." });
      }

      const existing = await findUserById(userId, true);
      if (!existing) return res.status(404).json({ ok: false, error: "A fiók nem található." });

      const nextName = req.body?.name !== undefined ? cleanText(req.body.name, 120) : existing.name;
      const nextEmail = req.body?.email !== undefined ? normalizeEmail(req.body.email) : existing.email;
      const nextRole = req.body?.role !== undefined ? String(req.body.role) : existing.role;
      const nextActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : existing.is_active;
      const permissionOverrides = req.body?.permissionOverrides !== undefined
        ? normalizePermissionOverrides(req.body.permissionOverrides)
        : normalizePermissionOverrides(existing.permission_overrides);

      if (!nextName || !nextEmail || !isValidEmail(nextEmail)) {
        return res.status(400).json({ ok: false, error: "Érvényes név és email cím szükséges." });
      }
      if (!ROLE_DEFINITIONS[nextRole]) {
        return res.status(400).json({ ok: false, error: "Érvénytelen szerepkör." });
      }
      if ((existing.role === "owner" || nextRole === "owner") && req.adminUser.role !== "owner") {
        return res.status(403).json({ ok: false, error: "Tulajdonosi fiókot csak tulajdonos módosíthat." });
      }
      if (userId === req.adminUser.id && !nextActive) {
        return res.status(400).json({ ok: false, error: "A saját fiókodat nem tilthatod le." });
      }

      if (existing.role === "owner" && (nextRole !== "owner" || !nextActive)) {
        const ownerCount = await activeOwnerCount();
        if (ownerCount <= 1) {
          return res.status(400).json({ ok: false, error: "Legalább egy aktív tulajdonosi fióknak maradnia kell." });
        }
      }

      try {
        const result = await pool.query(
          `
          UPDATE admin_users
          SET name = $1,
              email = $2,
              role = $3,
              permission_overrides = $4::jsonb,
              is_active = $5,
              updated_at = NOW()
          WHERE id = $6
          RETURNING id, name, email, role, permission_overrides, is_active,
                    must_change_password, last_login_at, created_at, updated_at
          `,
          [nextName, nextEmail, nextRole, JSON.stringify(permissionOverrides), nextActive, userId]
        );

        if (!nextActive) {
          await pool.query(`DELETE FROM admin_sessions WHERE user_id = $1`, [userId]);
        }

        await logAudit(req, "user.updated", "admin_user", userId, {
          previousRole: existing.role,
          role: nextRole,
          active: nextActive
        });

        return res.status(200).json({ ok: true, user: publicUser(result.rows[0]) });
      } catch (error) {
        if (error?.code === "23505") {
          return res.status(409).json({ ok: false, error: "Ezzel az email címmel már létezik fiók." });
        }
        throw error;
      }
    }));

    app.post("/api/admin/users/:id/reset-password", requirePermission("users.manage"), safe(async (req, res) => {
      const userId = Number(req.params.id);
      const password = String(req.body?.password || "");

      if (password.length < PASSWORD_MIN_LENGTH || password.length > 256) {
        return res.status(400).json({
          ok: false,
          error: `Az ideiglenes jelszó ${PASSWORD_MIN_LENGTH} és 256 karakter közötti legyen.`
        });
      }

      const existing = await findUserById(userId, true);
      if (!existing) return res.status(404).json({ ok: false, error: "A fiók nem található." });

      const passwordHash = await hashPassword(password);
      await pool.query(
        `
        UPDATE admin_users
        SET password_hash = $1, must_change_password = TRUE, updated_at = NOW()
        WHERE id = $2
        `,
        [passwordHash, userId]
      );
      await pool.query(`DELETE FROM admin_sessions WHERE user_id = $1`, [userId]);

      await logAudit(req, "user.password_reset", "admin_user", userId, { email: existing.email });
      return res.status(200).json({ ok: true });
    }));

    app.get("/api/admin/audit-log", requirePermission("audit.read"), safe(async (req, res) => {
      const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 80));
      const result = await pool.query(
        `
        SELECT l.id, l.action, l.target_type, l.target_id, l.metadata,
               l.ip_address, l.created_at, u.name AS user_name, u.email AS user_email
        FROM admin_audit_log l
        LEFT JOIN admin_users u ON u.id = l.user_id
        ORDER BY l.created_at DESC
        LIMIT $1
        `,
        [limit]
      );

      return res.status(200).json({ ok: true, entries: result.rows });
    }));
  }

  async function requireAuth(req, res, next) {
    try {
      await init();
      const rawToken = getCookie(req.headers.cookie || "", cookieName);
      if (!rawToken) return unauthorized(res);

      const tokenHash = hashSessionToken(rawToken);
      const result = await pool.query(
        `
        SELECT s.id AS session_id, s.token_hash, s.expires_at, s.last_seen_at,
               u.id, u.name, u.email, u.role, u.permission_overrides,
               u.is_active, u.must_change_password, u.last_login_at,
               u.created_at, u.updated_at
        FROM admin_sessions s
        JOIN admin_users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
          AND u.is_active = TRUE
        LIMIT 1
        `,
        [tokenHash]
      );

      const row = result.rows[0];
      if (!row) {
        clearSessionCookie(res, req);
        return unauthorized(res);
      }

      req.adminUser = row;
      req.adminUser.permissions = effectivePermissions(row.role, row.permission_overrides);
      req.adminSession = {
        id: row.session_id,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at
      };

      const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      if (Date.now() - lastSeen > 5 * 60 * 1000) {
        pool.query(`UPDATE admin_sessions SET last_seen_at = NOW() WHERE id = $1`, [row.session_id]).catch(() => {});
      }

      return next();
    } catch (error) {
      console.error("Admin auth error:", error);
      return res.status(500).json({ ok: false, error: "Hitelesítési hiba." });
    }
  }

  function requirePermission(permission) {
    return [
      requireAuth,
      (req, res, next) => {
        if (req.adminUser.must_change_password) {
          return res.status(428).json({
            ok: false,
            error: "A folytatáshoz előbb módosítsd az ideiglenes jelszavad.",
            mustChangePassword: true
          });
        }
        if (!req.adminUser.permissions.includes(permission)) {
          return res.status(403).json({
            ok: false,
            error: "Ehhez a művelethez nincs jogosultságod.",
            requiredPermission: permission
          });
        }
        return next();
      }
    ];
  }

  async function logAudit(req, action, targetType = null, targetId = null, metadata = {}) {
    return logAuditRaw(req.adminUser?.id || null, action, targetType, targetId, metadata, req);
  }

  async function logAuditRaw(userId, action, targetType, targetId, metadata, req) {
    try {
      await pool.query(
        `
        INSERT INTO admin_audit_log
          (user_id, action, target_type, target_id, metadata, ip_address)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        `,
        [userId, action, targetType, targetId === null ? null : String(targetId), JSON.stringify(metadata || {}), clientIp(req)]
      );
    } catch (error) {
      console.error("Audit log error:", error);
    }
  }

  function hasPermission(user, permission) {
    return effectivePermissions(user?.role, user?.permission_overrides).includes(permission);
  }

  return {
    init,
    mountRoutes,
    requireAuth,
    requirePermission,
    logAudit,
    hasPermission,
    roles: ROLE_DEFINITIONS,
    permissions: PERMISSION_DEFINITIONS
  };

  async function findUserById(userId, includePassword = false) {
    const fields = includePassword
      ? "*"
      : `id, name, email, role, permission_overrides, is_active,
         must_change_password, last_login_at, created_at, updated_at`;
    const result = await pool.query(`SELECT ${fields} FROM admin_users WHERE id = $1 LIMIT 1`, [userId]);
    return result.rows[0] || null;
  }

  async function activeOwnerCount() {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM admin_users WHERE role = 'owner' AND is_active = TRUE`);
    return result.rows[0]?.count || 0;
  }

  function publicUser(user) {
    const permissions = effectivePermissions(user.role, user.permission_overrides);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      roleLabel: ROLE_DEFINITIONS[user.role]?.label || user.role,
      permissionOverrides: normalizePermissionOverrides(user.permission_overrides),
      permissions,
      isActive: Boolean(user.is_active),
      mustChangePassword: Boolean(user.must_change_password),
      lastLoginAt: user.last_login_at,
      createdAt: user.created_at,
      updatedAt: user.updated_at
    };
  }

  function publicRoleDefinitions() {
    return Object.fromEntries(
      Object.entries(ROLE_DEFINITIONS).map(([key, value]) => [
        key,
        {
          label: value.label,
          description: value.description,
          permissions: [...value.permissions]
        }
      ])
    );
  }

  function effectivePermissions(role, rawOverrides) {
    if (role === "owner") {
      return Object.keys(PERMISSION_DEFINITIONS).sort();
    }
    const base = new Set(ROLE_DEFINITIONS[role]?.permissions || []);
    const overrides = normalizePermissionOverrides(rawOverrides);
    for (const [permission, allowed] of Object.entries(overrides)) {
      if (!PERMISSION_DEFINITIONS[permission]) continue;
      if (allowed) base.add(permission);
      else base.delete(permission);
    }
    return [...base].sort();
  }

  function normalizePermissionOverrides(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const normalized = {};
    for (const [permission, allowed] of Object.entries(value)) {
      if (PERMISSION_DEFINITIONS[permission] && typeof allowed === "boolean") {
        normalized[permission] = allowed;
      }
    }
    return normalized;
  }

  function isRateLimited(key) {
    const now = Date.now();
    const record = loginAttempts.get(key);
    if (!record) return false;
    if (record.resetAt <= now) {
      loginAttempts.delete(key);
      return false;
    }
    return record.count >= LOGIN_MAX_ATTEMPTS;
  }

  function registerFailedAttempt(key) {
    const now = Date.now();
    const record = loginAttempts.get(key);
    if (!record || record.resetAt <= now) {
      loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return;
    }
    record.count += 1;
  }

  function clearAttempts(key) {
    loginAttempts.delete(key);
  }

  function setSessionCookie(res, req, rawToken, maxAgeSeconds) {
    const secure = isSecureRequest(req);
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${rawToken}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`
    );
  }

  function clearSessionCookie(res, req) {
    const secure = isSecureRequest(req);
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`
    );
  }
}

function unauthorized(res) {
  return res.status(401).json({ ok: false, error: "Jelentkezz be az adminfelület használatához." });
}

function hashSessionToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const cost = 16384;
  const blockSize = 8;
  const parallelization = 1;

  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      salt,
      64,
      { N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) return reject(error);
        resolve(
          [
            "scrypt",
            cost,
            blockSize,
            parallelization,
            salt.toString("base64url"),
            derivedKey.toString("base64url")
          ].join("$")
        );
      }
    );
  });
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return Promise.resolve(false);

  const [, costValue, blockSizeValue, parallelizationValue, saltValue, hashValue] = parts;
  const cost = Number(costValue);
  const blockSize = Number(blockSizeValue);
  const parallelization = Number(parallelizationValue);
  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(hashValue, "base64url");

  return new Promise((resolve) => {
    crypto.scrypt(
      String(password),
      salt,
      expected.length,
      { N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error || derivedKey.length !== expected.length) return resolve(false);
        resolve(crypto.timingSafeEqual(derivedKey, expected));
      }
    );
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function getCookie(cookieHeader, name) {
  const item = String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!item) return null;
  return decodeURIComponent(item.slice(name.length + 1));
}

function clientIp(req) {
  return cleanText(
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      "",
    120
  );
}

function isSecureRequest(req) {
  return Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
}

module.exports = { createAdminAuth, ROLE_DEFINITIONS, PERMISSION_DEFINITIONS };
