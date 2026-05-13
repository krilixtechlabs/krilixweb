const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Resend } = require("resend");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const publicPath = path.join(__dirname, "public");
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const resend = new Resend(process.env.RESEND_API_KEY || "missing-key");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const COOKIE_NAME = "krilix_admin";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.RESEND_API_KEY || "change-this-secret";

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

initDatabase();

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

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicPath, "admin.html"));
});

app.get("/thread/:token", (req, res) => {
  res.sendFile(path.join(publicPath, "thread.html"));
});

app.get("/adatkezeles", (req, res) => {
  res.sendFile(path.join(publicPath, "adatkezeles.html"));
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  return res.status(200).json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: "Hiányzik az ADMIN_PASSWORD változó." });
  }

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Hibás jelszó." });
  }

  const token = createSessionToken();
  const secureCookie = req.secure || req.headers["x-forwarded-proto"] === "https";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${secureCookie ? "; Secure" : ""}`
  );

  return res.status(200).json({ ok: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const secureCookie = req.secure || req.headers["x-forwarded-proto"] === "https";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureCookie ? "; Secure" : ""}`
  );

  return res.status(200).json({ ok: true });
});

app.get("/api/admin/messages", requireAdmin, async (req, res) => {
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

app.post("/api/admin/messages/:id/read", requireAdmin, async (req, res) => {
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

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Mark read error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült olvasottra állítani." });
  }
});

app.patch("/api/admin/messages/:id", requireAdmin, async (req, res) => {
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

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Admin update error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült menteni." });
  }
});

app.delete("/api/admin/messages/:id", requireAdmin, async (req, res) => {
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
      SELECT id, sender, message, created_at
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

app.post("/api/admin/thread/:token/reply", requireAdmin, async (req, res) => {
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
      `INSERT INTO conversation_messages (contact_message_id, sender, message) VALUES ($1, 'admin', $2)`,
      [contact.id, message.trim()]
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

    return res.status(200).json({ ok: true, message: "Krilix válasz elküldve." });
  } catch (error) {
    console.error("Admin thread reply error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült elküldeni az admin választ." });
  }
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(publicPath, "404.html"));
});

app.listen(PORT, () => {
  console.log(`Krilix site is running on port ${PORT}`);
});

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

    console.log("Database ready.");
  } catch (error) {
    console.error("Database init error:", error);
  }
}

function requireAdmin(req, res, next) {
  const token = getCookie(req.headers.cookie || "", COOKIE_NAME);
  if (!token || !verifySessionToken(token)) {
    return res.status(401).json({ ok: false, error: "Nincs jogosultság." });
  }
  next();
}

function createSessionToken() {
  const payload = { exp: Date.now() + 24 * 60 * 60 * 1000 };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return false;

  const expectedSignature = crypto.createHmac("sha256", SESSION_SECRET).update(encodedPayload).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
    return payload.exp && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function getCookie(cookieHeader, name) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.split("=")[1];
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
