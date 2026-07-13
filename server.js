const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Resend } = require("resend");
const { createAdminAuth } = require("./admin-auth");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const publicPath = path.join(__dirname, "public");
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const resend = new Resend(process.env.RESEND_API_KEY || "missing-key");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const adminAuth = createAdminAuth({ pool, cookieName: "krilix_admin" });

const BUSINESS_STATUSES = new Set([
  "new_lead",
  "in_discussion",
  "offer_sent",
  "accepted",
  "declined",
  "closed"
]);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicPath));


app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message, attachmentLink } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "Hiányzó mezők." });
    }

    assertMailConfig();

    const threadToken = crypto.randomBytes(32).toString("hex");

    const saved = await pool.query(
      `
      INSERT INTO contact_messages
        (name, email, message, attachment_link, thread_token, business_status, has_unread_customer_message, last_activity_at)
      VALUES ($1, $2, $3, $4, $5, 'new_lead', TRUE, NOW())
      RETURNING id, created_at, thread_token
      `,
      [name.trim(), email.trim(), message.trim(), cleanOptional(attachmentLink), threadToken]
    );

    const contactId = saved.rows[0].id;
    const projectCode = buildProjectCode(contactId, saved.rows[0].created_at);

    await pool.query(
      `UPDATE contact_messages SET project_code = $1 WHERE id = $2`,
      [projectCode, contactId]
    );

    await pool.query(
      `
      INSERT INTO conversation_messages (contact_message_id, sender, message)
      VALUES ($1, 'customer', $2)
      `,
      [contactId, message.trim()]
    );

    const threadUrl = `${BASE_URL}/thread/${threadToken}`;
    const fromEmail = getFromEmail();

    await resend.emails.send({
      from: fromEmail,
      to: process.env.CONTACT_TO_EMAIL,
      replyTo: email.trim(),
      subject: `Új megkeresés ${projectCode} - ${name}`,
      html: adminNewMessageEmail({
        projectCode,
        name: escapeHtml(name),
        email: escapeHtml(email),
        message: htmlLines(message),
        attachmentLink: cleanOptional(attachmentLink),
        adminUrl: `${BASE_URL}/admin`,
        threadUrl
      })
    });

    await resend.emails.send({
      from: fromEmail,
      to: email.trim(),
      subject: "Megkaptuk az üzeneted - Krilix Tech & Labs",
      html: customerConfirmationEmail({
        name: escapeHtml(name),
        message: htmlLines(message),
        threadUrl
      })
    });

    return res.status(200).json({ ok: true, message: "Üzenet elküldve." });
  } catch (error) {
    console.error("Contact form error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült elküldeni az üzenetet." });
  }
});


app.post("/api/brief", async (req, res) => {
  try {
    const brief = normalizeBriefPayload(req.body);

    if (!brief.name || !brief.email || !brief.mainGoal) {
      return res.status(400).json({ ok: false, error: "Hiányzó kötelező mezők." });
    }

    assertMailConfig();

    const saved = await pool.query(
      `
      INSERT INTO project_briefs
        (name, email, phone, company, current_website, social_link, project_types, main_goal, materials, material_links, style_direction, colors, reference_links, avoid, features, custom_features, technical, domain, languages, deadline, budget, priority, extra_message, status, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16, $17::jsonb, $18, $19, $20, $21, $22, $23, 'new', NOW(), NOW())
      RETURNING id, created_at
      `,
      [
        brief.name,
        brief.email,
        brief.phone || null,
        brief.company || null,
        brief.currentWebsite || null,
        brief.socialLink || null,
        JSON.stringify(brief.projectTypes),
        brief.mainGoal,
        JSON.stringify(brief.materials),
        brief.materialLinks || null,
        brief.styleDirection || null,
        brief.colors || null,
        brief.references || null,
        brief.avoid || null,
        JSON.stringify(brief.features),
        brief.customFeatures || null,
        JSON.stringify(brief.technical),
        brief.domain || null,
        brief.languages || null,
        brief.deadline || null,
        brief.budget || null,
        brief.priority || null,
        brief.extraMessage || null
      ]
    );

    brief.id = saved.rows[0].id;
    brief.createdAt = saved.rows[0].created_at;
    brief.briefCode = buildBriefCode(brief.id, brief.createdAt);

    await pool.query(
      `UPDATE project_briefs SET brief_code = $1 WHERE id = $2`,
      [brief.briefCode, brief.id]
    );

    const fromEmail = getFromEmail();

    await resend.emails.send({
      from: fromEmail,
      to: process.env.CONTACT_TO_EMAIL,
      replyTo: brief.email,
      subject: `Új projekt brief ${brief.briefCode} - ${brief.name}${brief.company ? " / " + brief.company : ""}`,
      html: adminBriefEmail(brief)
    });

    await resend.emails.send({
      from: fromEmail,
      to: brief.email,
      subject: "Megkaptuk a projekt briefet - Krilix Tech & Labs",
      html: customerBriefConfirmationEmail(brief)
    });

    return res.status(200).json({ ok: true, message: "Brief elküldve.", briefCode: brief.briefCode });
  } catch (error) {
    console.error("Brief form error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült elküldeni a briefet." });
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicPath, "admin.html"));
});

app.get("/thread/:token", (req, res) => {
  res.sendFile(path.join(publicPath, "thread.html"));
});

app.get("/brief", (req, res) => {
  res.sendFile(path.join(publicPath, "brief.html"));
});

app.get("/adatkezeles", (req, res) => {
  res.sendFile(path.join(publicPath, "adatkezeles.html"));
});

adminAuth.mountRoutes(app);


app.get("/api/admin/briefs", adminAuth.requirePermission("briefs.read"), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM project_briefs
      ORDER BY created_at DESC
      `
    );
    return res.status(200).json({ ok: true, briefs: result.rows.map(formatBriefRow) });
  } catch (error) {
    console.error("Admin briefs error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült betölteni a briefeket." });
  }
});

app.get("/api/admin/briefs/:id", adminAuth.requirePermission("briefs.read"), async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM project_briefs WHERE id = $1`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Brief nem található." });
    return res.status(200).json({ ok: true, brief: formatBriefRow(result.rows[0]) });
  } catch (error) {
    console.error("Admin brief detail error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült betölteni a briefet." });
  }
});

app.patch("/api/admin/briefs/:id", adminAuth.requirePermission("briefs.write"), async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const allowedStatuses = new Set(["new", "contacted", "processing", "offer_ready", "offer_sent", "accepted", "declined", "closed"]);

    if (status && !allowedStatuses.has(status)) {
      return res.status(400).json({ ok: false, error: "Érvénytelen státusz." });
    }

    const result = await pool.query(
      `
      UPDATE project_briefs
      SET
        status = COALESCE($1, status),
        admin_note = COALESCE($2, admin_note),
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
      `,
      [status || null, typeof adminNote === "string" ? adminNote : null, req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Brief nem található." });
    await adminAuth.logAudit(req, "brief.updated", "project_brief", req.params.id, {
      status: status || undefined,
      noteChanged: typeof adminNote === "string"
    });
    return res.status(200).json({ ok: true, brief: formatBriefRow(result.rows[0]) });
  } catch (error) {
    console.error("Admin brief update error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült menteni a briefet." });
  }
});

app.delete("/api/admin/briefs/:id", adminAuth.requirePermission("briefs.delete"), async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM project_briefs WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Brief nem található." });
    await adminAuth.logAudit(req, "brief.deleted", "project_brief", req.params.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Admin brief delete error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült törölni a briefet." });
  }
});

app.get("/api/admin/messages", adminAuth.requirePermission("messages.read"), async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        cm.id,
        cm.project_code,
        cm.name,
        cm.email,
        cm.message,
        cm.attachment_link,
        cm.status,
        cm.business_status,
        cm.admin_note,
        cm.has_unread_customer_message,
        cm.last_activity_at,
        cm.last_seen_by_admin_at,
        cm.reply_message,
        cm.replied_at,
        cm.created_at,
        cm.thread_token,
        (
          SELECT c.message
          FROM conversation_messages c
          WHERE c.contact_message_id = cm.id
          ORDER BY c.created_at DESC
          LIMIT 1
        ) AS last_message,
        (
          SELECT c.sender
          FROM conversation_messages c
          WHERE c.contact_message_id = cm.id
          ORDER BY c.created_at DESC
          LIMIT 1
        ) AS last_sender
      FROM contact_messages cm
      ORDER BY cm.last_activity_at DESC NULLS LAST, cm.created_at DESC
      `
    );

    const messages = result.rows.map((row) => ({
      ...row,
      thread_url: `${BASE_URL}/thread/${row.thread_token}`
    }));

    return res.status(200).json({ ok: true, messages });
  } catch (error) {
    console.error("Admin messages error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült lekérni a megkereséseket." });
  }
});

app.post("/api/admin/messages/:id/read", adminAuth.requirePermission("messages.read"), async (req, res) => {
  try {
    await pool.query(
      `
      UPDATE contact_messages
      SET has_unread_customer_message = FALSE,
          last_seen_by_admin_at = NOW(),
          status = CASE WHEN status = 'new' THEN 'opened' ELSE status END
      WHERE id = $1
      `,
      [req.params.id]
    );

    await adminAuth.logAudit(req, "message.read", "contact_message", req.params.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Mark read error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült olvasottra állítani." });
  }
});

app.patch("/api/admin/messages/:id", adminAuth.requirePermission("messages.write"), async (req, res) => {
  try {
    const { businessStatus, adminNote } = req.body;

    const fields = [];
    const values = [];

    if (businessStatus !== undefined) {
      if (!BUSINESS_STATUSES.has(businessStatus)) {
        return res.status(400).json({ ok: false, error: "Érvénytelen státusz." });
      }
      values.push(businessStatus);
      fields.push(`business_status = $${values.length}`);
    }

    if (adminNote !== undefined) {
      values.push(String(adminNote || "").trim());
      fields.push(`admin_note = $${values.length}`);
    }

    if (!fields.length) {
      return res.status(400).json({ ok: false, error: "Nincs módosítandó adat." });
    }

    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE contact_messages SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING id`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "A megkeresés nem található." });
    }

    await adminAuth.logAudit(req, "message.updated", "contact_message", req.params.id, {
      businessStatus: businessStatus || undefined,
      noteChanged: adminNote !== undefined
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Admin update error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült menteni." });
  }
});

app.delete("/api/admin/messages/:id", adminAuth.requirePermission("messages.delete"), async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query("BEGIN");

    const existing = await client.query(`SELECT id FROM contact_messages WHERE id = $1`, [id]);
    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "A megkeresés nem található." });
    }

    await client.query(`DELETE FROM conversation_messages WHERE contact_message_id = $1`, [id]);
    await client.query(`DELETE FROM contact_messages WHERE id = $1`, [id]);
    await client.query("COMMIT");

    await adminAuth.logAudit(req, "message.deleted", "contact_message", id);
    return res.status(200).json({ ok: true, message: "A megkeresés törölve lett." });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete message error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült törölni a megkeresést." });
  } finally {
    client.release();
  }
});

app.get("/api/thread/:token", async (req, res) => {
  try {
    const contactResult = await pool.query(
      `
      SELECT id, project_code, name, email, message, attachment_link, created_at, business_status
      FROM contact_messages
      WHERE thread_token = $1
      `,
      [req.params.token]
    );

    if (!contactResult.rows.length) {
      return res.status(404).json({ ok: false, error: "A beszélgetés nem található." });
    }

    const contact = contactResult.rows[0];

    const messagesResult = await pool.query(
      `
      SELECT id, sender, message, sender_name, created_at
      FROM conversation_messages
      WHERE contact_message_id = $1
      ORDER BY created_at ASC
      `,
      [contact.id]
    );

    return res.status(200).json({ ok: true, contact, messages: messagesResult.rows });
  } catch (error) {
    console.error("Thread fetch error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült betölteni a beszélgetést." });
  }
});

app.post("/api/thread/:token/reply", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: "Az üzenet nem lehet üres." });
    }

    const contactResult = await pool.query(
      `SELECT id, project_code, name, email FROM contact_messages WHERE thread_token = $1`,
      [req.params.token]
    );

    if (!contactResult.rows.length) {
      return res.status(404).json({ ok: false, error: "A beszélgetés nem található." });
    }

    const contact = contactResult.rows[0];

    await pool.query(
      `INSERT INTO conversation_messages (contact_message_id, sender, message) VALUES ($1, 'customer', $2)`,
      [contact.id, message.trim()]
    );

    await pool.query(
      `
      UPDATE contact_messages
      SET has_unread_customer_message = TRUE,
          status = 'new',
          last_activity_at = NOW()
      WHERE id = $1
      `,
      [contact.id]
    );

    await resend.emails.send({
      from: getFromEmail(),
      to: process.env.CONTACT_TO_EMAIL,
      replyTo: contact.email,
      subject: `Új ügyfél válasz ${contact.project_code || `#${contact.id}`} - ${contact.name}`,
      html: customerThreadReplyEmail({
        projectCode: escapeHtml(contact.project_code || `#${contact.id}`),
        name: escapeHtml(contact.name),
        email: escapeHtml(contact.email),
        message: htmlLines(message),
        adminUrl: `${BASE_URL}/admin`
      })
    });

    return res.status(200).json({ ok: true, message: "Üzenet elküldve." });
  } catch (error) {
    console.error("Thread reply error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült elküldeni az üzenetet." });
  }
});

app.post("/api/admin/thread/:token/reply", adminAuth.requirePermission("messages.reply"), async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, error: "Az üzenet nem lehet üres." });
    }

    const contactResult = await pool.query(
      `SELECT id, project_code, name, email, thread_token FROM contact_messages WHERE thread_token = $1`,
      [req.params.token]
    );

    if (!contactResult.rows.length) {
      return res.status(404).json({ ok: false, error: "A beszélgetés nem található." });
    }

    const contact = contactResult.rows[0];
    const threadUrl = `${BASE_URL}/thread/${contact.thread_token}`;

    await pool.query(
      `
      INSERT INTO conversation_messages
        (contact_message_id, sender, message, admin_user_id, sender_name)
      VALUES ($1, 'admin', $2, $3, $4)
      `,
      [contact.id, message.trim(), req.adminUser.id, req.adminUser.name]
    );

    await pool.query(
      `
      UPDATE contact_messages
      SET status = 'replied',
          reply_message = $1,
          replied_at = NOW(),
          has_unread_customer_message = FALSE,
          last_seen_by_admin_at = NOW(),
          last_activity_at = NOW()
      WHERE id = $2
      `,
      [message.trim(), contact.id]
    );

    await resend.emails.send({
      from: getFromEmail(),
      to: contact.email,
      bcc: process.env.CONTACT_TO_EMAIL,
      subject: "Válasz érkezett - Krilix Tech & Labs",
      html: replyNotificationEmail({
        name: escapeHtml(contact.name),
        reply: htmlLines(message),
        threadUrl
      })
    });

    await adminAuth.logAudit(req, "message.replied", "contact_message", contact.id, {
      projectCode: contact.project_code
    });
    return res.status(200).json({ ok: true, message: "Krilix válasz elküldve." });
  } catch (error) {
    console.error("Admin thread reply error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült elküldeni az admin választ." });
  }
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ ok: false, error: "Váratlan szerverhiba történt." });
  }
  return next(error);
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(publicPath, "404.html"));
});

async function startServer() {
  try {
    await initDatabase();
    await adminAuth.init();
    app.listen(PORT, () => {
      console.log(`Krilix site is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Krilix server startup failed:", error);
    process.exit(1);
  }
}

startServer();

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        reply_message TEXT,
        replied_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS thread_token TEXT UNIQUE;`);
    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS project_code TEXT;`);
    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS business_status TEXT DEFAULT 'new_lead';`);
    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS admin_note TEXT;`);
    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS attachment_link TEXT;`);
    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP DEFAULT NOW();`);
    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS last_seen_by_admin_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS has_unread_customer_message BOOLEAN DEFAULT TRUE;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id SERIAL PRIMARY KEY,
        contact_message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS seen_by_admin BOOLEAN DEFAULT FALSE;`);

    const missing = await pool.query(`SELECT id, created_at FROM contact_messages WHERE thread_token IS NULL OR project_code IS NULL OR last_activity_at IS NULL`);
    for (const row of missing.rows) {
      const token = crypto.randomBytes(32).toString("hex");
      await pool.query(
        `
        UPDATE contact_messages
        SET thread_token = COALESCE(thread_token, $1),
            project_code = COALESCE(project_code, $2),
            last_activity_at = COALESCE(last_activity_at, created_at)
        WHERE id = $3
        `,
        [token, buildProjectCode(row.id, row.created_at), row.id]
      );
    }

    const withoutConversation = await pool.query(`
      SELECT cm.id, cm.message
      FROM contact_messages cm
      WHERE NOT EXISTS (SELECT 1 FROM conversation_messages c WHERE c.contact_message_id = cm.id)
    `);

    for (const row of withoutConversation.rows) {
      await pool.query(
        `INSERT INTO conversation_messages (contact_message_id, sender, message) VALUES ($1, 'customer', $2)`,
        [row.id, row.message]
      );
    }


    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_briefs (
        id SERIAL PRIMARY KEY,
        brief_code TEXT UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        current_website TEXT,
        social_link TEXT,
        project_types JSONB NOT NULL DEFAULT '[]'::jsonb,
        main_goal TEXT NOT NULL,
        materials JSONB NOT NULL DEFAULT '[]'::jsonb,
        material_links TEXT,
        style_direction TEXT,
        colors TEXT,
        reference_links TEXT,
        avoid TEXT,
        features JSONB NOT NULL DEFAULT '[]'::jsonb,
        custom_features TEXT,
        technical JSONB NOT NULL DEFAULT '[]'::jsonb,
        domain TEXT,
        languages TEXT,
        deadline TEXT,
        budget TEXT,
        priority TEXT,
        extra_message TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        admin_note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE project_briefs ADD COLUMN IF NOT EXISTS brief_code TEXT UNIQUE;`);
    await pool.query(`ALTER TABLE project_briefs ADD COLUMN IF NOT EXISTS admin_note TEXT;`);
    await pool.query(`ALTER TABLE project_briefs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
    await pool.query(`ALTER TABLE project_briefs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new';`);

    const briefsWithoutCode = await pool.query(`SELECT id, created_at FROM project_briefs WHERE brief_code IS NULL`);
    for (const row of briefsWithoutCode.rows) {
      await pool.query(
        `UPDATE project_briefs SET brief_code = $1 WHERE id = $2`,
        [buildBriefCode(row.id, row.created_at), row.id]
      );
    }

    console.log("Database ready.");
  } catch (error) {
    console.error("Database init error:", error);
  }
}

function normalizeBriefPayload(body) {
  const pick = key => cleanOptional(body[key]) || "";
  const arr = key => Array.isArray(body[key])
    ? body[key].map(item => String(item || "").trim()).filter(Boolean).slice(0, 60)
    : [];

  return {
    name: pick("name"),
    email: pick("email"),
    phone: pick("phone"),
    company: pick("company"),
    currentWebsite: pick("currentWebsite"),
    socialLink: pick("socialLink"),
    projectTypes: arr("projectTypes"),
    mainGoal: pick("mainGoal"),
    materials: arr("materials"),
    materialLinks: pick("materialLinks"),
    styleDirection: pick("styleDirection"),
    colors: pick("colors"),
    references: pick("references"),
    avoid: pick("avoid"),
    features: arr("features"),
    customFeatures: pick("customFeatures"),
    technical: arr("technical"),
    domain: pick("domain"),
    languages: pick("languages"),
    deadline: pick("deadline"),
    budget: pick("budget"),
    priority: pick("priority"),
    extraMessage: pick("extraMessage")
  };
}

function buildBriefCode(id, dateValue) {
  const year = new Date(dateValue || Date.now()).getFullYear();
  return `BRF-${year}-${String(id).padStart(4, "0")}`;
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatBriefRow(row) {
  return {
    id: row.id,
    briefCode: row.brief_code || buildBriefCode(row.id, row.created_at),
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    currentWebsite: row.current_website,
    socialLink: row.social_link,
    projectTypes: safeJsonArray(row.project_types),
    mainGoal: row.main_goal,
    materials: safeJsonArray(row.materials),
    materialLinks: row.material_links,
    styleDirection: row.style_direction,
    colors: row.colors,
    references: row.reference_links,
    avoid: row.avoid,
    features: safeJsonArray(row.features),
    customFeatures: row.custom_features,
    technical: safeJsonArray(row.technical),
    domain: row.domain,
    languages: row.languages,
    deadline: row.deadline,
    budget: row.budget,
    priority: row.priority,
    extraMessage: row.extra_message,
    status: row.status || "new",
    adminNote: row.admin_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function briefList(values) {
  if (!values || !values.length) return `<span style="color:#8f8678;">Nincs megadva</span>`;
  return `<ul style="margin:8px 0 0; padding-left:20px;">${values.map(value => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function briefText(value) {
  const text = cleanOptional(value);
  return text ? htmlLines(text) : `<span style="color:#8f8678;">Nincs megadva</span>`;
}

function briefLink(value) {
  const text = cleanOptional(value);
  if (!text) return `<span style="color:#8f8678;">Nincs megadva</span>`;
  const safe = escapeHtml(text);
  return `<a href="${safe}" style="color:#111;">${safe}</a>`;
}

function briefRow(label, value) {
  return `
    <tr>
      <td style="width:210px; padding:10px 14px; border-bottom:1px solid #ded3bd; color:#8a6a2c; font-weight:700; font-size:13px;">${label}</td>
      <td style="padding:10px 14px; border-bottom:1px solid #ded3bd; color:#111; font-size:14px; line-height:1.6;">${value}</td>
    </tr>
  `;
}

function briefBlock(title, rows) {
  return `
    <div style="margin-top:24px; border:1px solid #ded3bd; background:#fffaf0;">
      <div style="padding:14px 16px; background:#f4efe5; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">${title}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </div>
  `;
}

function adminBriefEmail(brief) {
  return emailShell({
    dark: false,
    label: "Krilix Tech & Labs",
    title: "Új projekt brief érkezett.",
    content: `
      <p style="margin:0 0 18px;">Projektazonosító: <strong>${escapeHtml(brief.briefCode || "")}</strong></p>
      ${briefBlock("Alap adatok", [
        briefRow("Név", briefText(brief.name)),
        briefRow("Email", `<a href="mailto:${escapeHtml(brief.email)}" style="color:#111;">${escapeHtml(brief.email)}</a>`),
        briefRow("Telefonszám", briefText(brief.phone)),
        briefRow("Cég / márkanév", briefText(brief.company)),
        briefRow("Jelenlegi weboldal", briefLink(brief.currentWebsite)),
        briefRow("Social link", briefLink(brief.socialLink))
      ].join(""))}
      ${briefBlock("Projekt típusa és célja", [
        briefRow("Projekt típusok", briefList(brief.projectTypes)),
        briefRow("Fő cél", briefText(brief.mainGoal))
      ].join(""))}
      ${briefBlock("Tartalom és anyagok", [
        briefRow("Anyagok állapota", briefList(brief.materials)),
        briefRow("Anyag linkek", briefText(brief.materialLinks))
      ].join(""))}
      ${briefBlock("Dizájn irány", [
        briefRow("Stílus", briefText(brief.styleDirection)),
        briefRow("Színek", briefText(brief.colors)),
        briefRow("Referencia oldalak", briefText(brief.references)),
        briefRow("Kerülendő dolgok", briefText(brief.avoid))
      ].join(""))}
      ${briefBlock("Funkciók", [
        briefRow("Kért funkciók", briefList(brief.features)),
        briefRow("Egyedi funkciók", briefText(brief.customFeatures))
      ].join(""))}
      ${briefBlock("Technikai háttér", [
        briefRow("Technikai igények", briefList(brief.technical)),
        briefRow("Domain", briefText(brief.domain)),
        briefRow("Nyelvek", briefText(brief.languages))
      ].join(""))}
      ${briefBlock("Határidő és keret", [
        briefRow("Határidő", briefText(brief.deadline)),
        briefRow("Tervezett keret", briefText(brief.budget)),
        briefRow("Sürgősség", briefText(brief.priority)),
        briefRow("Egyéb megjegyzés", briefText(brief.extraMessage))
      ].join(""))}
      ${buttonHtml({ href: `${BASE_URL}/admin`, text: "Megnyitás adminban" })}
    `
  });
}

function customerBriefConfirmationEmail(brief) {
  return emailShell({
    dark: true,
    label: "Brief megérkezett",
    title: `Köszönjük, ${escapeHtml(brief.name)}.`,
    content: `
      <p style="margin:0 0 22px;">Megkaptuk a projekt briefet. Átnézzük az elküldött információkat, és ezek alapján tudunk továbbmenni a következő lépésekkel.</p>
      <div style="padding:24px; background:#0c0c0c; border:1px solid rgba(231,200,121,.22); color:#f7f1e6;">
        <div style="margin-bottom:14px; color:#e7c879; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">Rövid összefoglaló</div>
        <p style="margin:0 0 10px;"><strong>Projekt:</strong> ${brief.projectTypes.length ? escapeHtml(brief.projectTypes.join(", ")) : "Nincs megadva"}</p>
        <p style="margin:0 0 10px;"><strong>Fő cél:</strong><br>${briefText(brief.mainGoal)}</p>
        <p style="margin:0;"><strong>Határidő:</strong> ${brief.deadline ? escapeHtml(brief.deadline) : "Nincs megadva"}</p>
      </div>
      <p style="margin:24px 0 0;">Ha valami fontos kimaradt, válaszolj erre az emailre, és kiegészítheted.</p>
    `
  });
}


function assertMailConfig() {
  if (!process.env.RESEND_API_KEY) throw new Error("Hiányzik a RESEND_API_KEY.");
  if (!process.env.CONTACT_TO_EMAIL) throw new Error("Hiányzik a CONTACT_TO_EMAIL.");
}

function getFromEmail() {
  return process.env.CONTACT_FROM_EMAIL || "Krilix Tech & Labs <hello@krilixtechlabs.com>";
}

function cleanOptional(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function buildProjectCode(id, dateValue) {
  const year = new Date(dateValue || Date.now()).getFullYear();
  return `KRX-${year}-${String(id).padStart(4, "0")}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlLines(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function buttonHtml({ href, text }) {
  return `<div style="margin-top:26px;"><a href="${href}" style="display:inline-block; padding:15px 22px; background:#e7c879; color:#070707; text-decoration:none; font-size:14px; font-weight:700;">${text}</a></div>`;
}

function emailShell({ title, label, content, dark = true }) {
  const bg = dark ? "#070707" : "#f4efe5";
  const card = dark ? "#151515" : "#ffffff";
  const text = dark ? "#f7f1e6" : "#111111";
  const muted = dark ? "#b8ad9b" : "#665f54";
  const border = dark ? "rgba(231,200,121,.35)" : "#ded3bd";

  return `<!doctype html><html lang="hu"><body style="margin:0; padding:0; background:${bg}; font-family:Arial, Helvetica, sans-serif; color:${text};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg}; padding:36px 16px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px; background:${card}; border:1px solid ${border};"><tr><td style="padding:38px 36px 28px;"><div style="font-size:11px; letter-spacing:4px; text-transform:uppercase; color:#e7c879; font-weight:700;">${label}</div><h1 style="margin:18px 0 0; font-family:Georgia, 'Times New Roman', serif; font-size:42px; line-height:1; font-weight:400; letter-spacing:-1.8px; color:${text};">${title}</h1></td></tr><tr><td style="padding:0 36px 34px; color:${muted}; font-size:16px; line-height:1.75;">${content}</td></tr><tr><td style="padding:22px 36px; border-top:1px solid rgba(231,200,121,.16); color:#8f8678; font-size:12px; line-height:1.6;">Krilix Tech & Labs — prémium weboldalak és működő webes megoldások.</td></tr></table></td></tr></table></body></html>`;
}

function adminNewMessageEmail({ projectCode, name, email, message, attachmentLink, adminUrl, threadUrl }) {
  return emailShell({
    dark: false,
    label: "Krilix Tech & Labs",
    title: "Új megkeresés érkezett.",
    content: `
      <p style="margin:0 0 18px;">Projektazonosító: <strong>${projectCode}</strong></p>
      <p style="margin:0 0 8px;"><strong>Név:</strong> ${name}</p>
      <p style="margin:0 0 22px;"><strong>Email:</strong> <a href="mailto:${email}" style="color:#111;">${email}</a></p>
      <div style="padding:24px; background:#f4efe5; border:1px solid #ded3bd; color:#111;"><div style="margin-bottom:14px; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">Üzenet</div>${message}</div>
      ${attachmentLink ? `<p style="margin:20px 0 0;"><strong>Csatolt link:</strong> <a href="${escapeHtml(attachmentLink)}" style="color:#111;">${escapeHtml(attachmentLink)}</a></p>` : ""}
      ${buttonHtml({ href: adminUrl, text: "Megnyitás adminban" })}
      <p style="margin-top:20px; font-size:13px;">Ügyfél privát link: <a href="${threadUrl}" style="color:#111;">${threadUrl}</a></p>
    `
  });
}

function customerConfirmationEmail({ name, message, threadUrl }) {
  return emailShell({
    dark: true,
    label: "Üzenet megérkezett",
    title: `Köszönjük, ${name}.`,
    content: `<p style="margin:0 0 22px;">Megkaptuk az üzeneted. Átnézzük, és hamarosan visszajelzünk a következő lépésekkel.</p><div style="padding:24px; background:#0c0c0c; border:1px solid rgba(231,200,121,.22); color:#f7f1e6;"><div style="margin-bottom:14px; color:#e7c879; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">Az elküldött üzeneted</div>${message}</div><p style="margin:24px 0 0;">A beszélgetést később ezen a privát linken tudod folytatni:</p>${buttonHtml({ href: threadUrl, text: "Beszélgetés megnyitása" })}`
  });
}

function replyNotificationEmail({ name, reply, threadUrl }) {
  return emailShell({
    dark: true,
    label: "Krilix Tech & Labs",
    title: "Válasz érkezett.",
    content: `<p style="margin:0 0 22px;">Szia ${name}, válasz érkezett a megkeresésedre.</p><div style="padding:24px; background:#0c0c0c; border:1px solid rgba(231,200,121,.22); color:#f7f1e6;">${reply}</div><p style="margin:24px 0 0;">A teljes beszélgetést itt tudod megnyitni és folytatni:</p>${buttonHtml({ href: threadUrl, text: "Beszélgetés megnyitása" })}`
  });
}

function customerThreadReplyEmail({ projectCode, name, email, message, adminUrl }) {
  return emailShell({
    dark: false,
    label: "Ügyfél válaszolt",
    title: "Új üzenet érkezett.",
    content: `<p style="margin:0 0 8px;"><strong>Azonosító:</strong> ${projectCode}</p><p style="margin:0 0 8px;"><strong>Név:</strong> ${name}</p><p style="margin:0 0 22px;"><strong>Email:</strong> <a href="mailto:${email}" style="color:#111;">${email}</a></p><div style="padding:24px; background:#f4efe5; border:1px solid #ded3bd; color:#111;"><div style="margin-bottom:14px; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">Üzenet</div>${message}</div>${buttonHtml({ href: adminUrl, text: "Megnyitás adminban" })}`
  });
}
