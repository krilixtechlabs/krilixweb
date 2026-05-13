const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Resend } = require("resend");

const app = express();

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const publicPath = path.join(__dirname, "public");

const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const COOKIE_NAME = "krilix_admin";
const SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  process.env.RESEND_API_KEY ||
  "change-this-secret";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicPath));

initDatabase();

app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({
        ok: false,
        error: "Hiányzó mezők."
      });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Hiányzik a RESEND_API_KEY."
      });
    }

    if (!process.env.CONTACT_TO_EMAIL) {
      return res.status(500).json({
        ok: false,
        error: "Hiányzik a CONTACT_TO_EMAIL."
      });
    }

    const threadToken = crypto.randomBytes(32).toString("hex");

    const savedMessage = await pool.query(
      `
      INSERT INTO contact_messages (name, email, message, thread_token)
      VALUES ($1, $2, $3, $4)
      RETURNING id, created_at, thread_token
      `,
      [name.trim(), email.trim(), message.trim(), threadToken]
    );

    const contactId = savedMessage.rows[0].id;

    await pool.query(
      `
      INSERT INTO conversation_messages (contact_message_id, sender, message)
      VALUES ($1, $2, $3)
      `,
      [contactId, "customer", message.trim()]
    );

    const threadUrl = `${BASE_URL}/thread/${threadToken}`;

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");

    const fromEmail =
      process.env.CONTACT_FROM_EMAIL ||
      "Krilix Tech & Labs <hello@krilixtechlabs.com>";

    await resend.emails.send({
      from: fromEmail,
      to: process.env.CONTACT_TO_EMAIL,
      replyTo: email,
      subject: `Új megkeresés #${contactId} - ${name}`,
      html: adminNewMessageEmail({
        id: contactId,
        name: safeName,
        email: safeEmail,
        message: safeMessage,
        adminUrl: `${BASE_URL}/admin`,
        threadUrl
      })
    });

    await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: "Megkaptuk az üzeneted - Krilix Tech & Labs",
      html: customerConfirmationEmail({
        name: safeName,
        message: safeMessage,
        threadUrl
      })
    });

    return res.status(200).json({
      ok: true,
      message: "Üzenet elküldve."
    });
  } catch (error) {
    console.error("Contact form error:", error);

    return res.status(500).json({
      ok: false,
      error: "Nem sikerült elküldeni az üzenetet."
    });
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicPath, "admin.html"));
});

app.get("/thread/:token", (req, res) => {
  res.sendFile(path.join(publicPath, "thread.html"));
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({
      ok: false,
      error: "Hiányzik az ADMIN_PASSWORD változó."
    });
  }

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: "Hibás jelszó."
    });
  }

  const token = createSessionToken();
  const secureCookie = req.headers["x-forwarded-proto"] === "https";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${secureCookie ? "; Secure" : ""}`
  );

  return res.status(200).json({
    ok: true
  });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const secureCookie = req.headers["x-forwarded-proto"] === "https";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureCookie ? "; Secure" : ""}`
  );

  return res.status(200).json({
    ok: true
  });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  return res.status(200).json({
    ok: true
  });
});

app.get("/api/admin/messages", requireAdmin, async (req, res) => {
  try {
    const contactsResult = await pool.query(
      `
      SELECT id, name, email, message, status, reply_message, replied_at, created_at, thread_token
      FROM contact_messages
      ORDER BY created_at DESC
      `
    );

    const contacts = contactsResult.rows;

    if (!contacts.length) {
      return res.status(200).json({
        ok: true,
        messages: []
      });
    }

    const ids = contacts.map((item) => item.id);

    const conversationResult = await pool.query(
      `
      SELECT id, contact_message_id, sender, message, created_at
      FROM conversation_messages
      WHERE contact_message_id = ANY($1::int[])
      ORDER BY created_at ASC
      `,
      [ids]
    );

    const grouped = {};

    for (const row of conversationResult.rows) {
      if (!grouped[row.contact_message_id]) {
        grouped[row.contact_message_id] = [];
      }

      grouped[row.contact_message_id].push(row);
    }

    const messages = contacts.map((contact) => ({
      ...contact,
      thread_url: `${BASE_URL}/thread/${contact.thread_token}`,
      conversation: grouped[contact.id] || []
    }));

    return res.status(200).json({
      ok: true,
      messages
    });
  } catch (error) {
    console.error("Admin messages error:", error);

    return res.status(500).json({
      ok: false,
      error: "Nem sikerült lekérni a megkereséseket."
    });
  }
});

app.post("/api/admin/messages/:id/reply", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reply } = req.body;

    if (!reply || !reply.trim()) {
      return res.status(400).json({
        ok: false,
        error: "A válasz nem lehet üres."
      });
    }

    const messageResult = await pool.query(
      `
      SELECT id, name, email, thread_token
      FROM contact_messages
      WHERE id = $1
      `,
      [id]
    );

    if (messageResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "A megkeresés nem található."
      });
    }

    const contact = messageResult.rows[0];
    const threadUrl = `${BASE_URL}/thread/${contact.thread_token}`;

    const fromEmail =
      process.env.CONTACT_FROM_EMAIL ||
      "Krilix Tech & Labs <hello@krilixtechlabs.com>";

    await pool.query(
      `
      INSERT INTO conversation_messages (contact_message_id, sender, message)
      VALUES ($1, $2, $3)
      `,
      [contact.id, "admin", reply.trim()]
    );

    await pool.query(
      `
      UPDATE contact_messages
      SET status = 'replied',
          reply_message = $1,
          replied_at = NOW()
      WHERE id = $2
      `,
      [reply.trim(), contact.id]
    );

    await resend.emails.send({
      from: fromEmail,
      to: contact.email,
      bcc: process.env.CONTACT_TO_EMAIL,
      subject: "Válasz érkezett - Krilix Tech & Labs",
      html: replyNotificationEmail({
        name: escapeHtml(contact.name),
        reply: escapeHtml(reply).replace(/\n/g, "<br>"),
        threadUrl
      })
    });

    return res.status(200).json({
      ok: true,
      message: "Válasz elküldve."
    });
  } catch (error) {
    console.error("Reply error:", error);

    return res.status(500).json({
      ok: false,
      error: "Nem sikerült elküldeni a választ."
    });
  }
});

app.get("/api/thread/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const contactResult = await pool.query(
      `
      SELECT id, name, email, message, created_at
      FROM contact_messages
      WHERE thread_token = $1
      `,
      [token]
    );

    if (contactResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "A beszélgetés nem található."
      });
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

    return res.status(200).json({
      ok: true,
      contact,
      messages: messagesResult.rows
    });
  } catch (error) {
    console.error("Thread fetch error:", error);

    return res.status(500).json({
      ok: false,
      error: "Nem sikerült betölteni a beszélgetést."
    });
  }
});

app.post("/api/admin/thread/:token/reply", requireAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Az üzenet nem lehet üres."
      });
    }

    const contactResult = await pool.query(
      `
      SELECT id, name, email, thread_token
      FROM contact_messages
      WHERE thread_token = $1
      `,
      [token]
    );

    if (contactResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "A beszélgetés nem található."
      });
    }

    const contact = contactResult.rows[0];
    const threadUrl = `${BASE_URL}/thread/${contact.thread_token}`;

    await pool.query(
      `
      INSERT INTO conversation_messages (contact_message_id, sender, message)
      VALUES ($1, $2, $3)
      `,
      [contact.id, "admin", message.trim()]
    );

    await pool.query(
      `
      UPDATE contact_messages
      SET status = 'replied',
          reply_message = $1,
          replied_at = NOW()
      WHERE id = $2
      `,
      [message.trim(), contact.id]
    );

    const fromEmail =
      process.env.CONTACT_FROM_EMAIL ||
      "Krilix Tech & Labs <hello@krilixtechlabs.com>";

    await resend.emails.send({
      from: fromEmail,
      to: contact.email,
      bcc: process.env.CONTACT_TO_EMAIL,
      subject: "Válasz érkezett - Krilix Tech & Labs",
      html: replyNotificationEmail({
        name: escapeHtml(contact.name),
        reply: escapeHtml(message).replace(/\n/g, "<br>"),
        threadUrl
      })
    });

    return res.status(200).json({
      ok: true,
      message: "Admin válasz elküldve."
    });
  } catch (error) {
    console.error("Admin thread reply error:", error);

    return res.status(500).json({
      ok: false,
      error: "Nem sikerült elküldeni az admin választ."
    });
  }
});

app.delete("/api/admin/messages/:id", requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const existing = await client.query(
      `
      SELECT id, name
      FROM contact_messages
      WHERE id = $1
      `,
      [id]
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        error: "A megkeresés nem található."
      });
    }

    await client.query(
      `
      DELETE FROM conversation_messages
      WHERE contact_message_id = $1
      `,
      [id]
    );

    await client.query(
      `
      DELETE FROM contact_messages
      WHERE id = $1
      `,
      [id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      ok: true,
      message: "A megkeresés és a teljes beszélgetés törölve lett."
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete message error:", error);

    return res.status(500).json({
      ok: false,
      error: "Nem sikerült törölni a megkeresést."
    });
  } finally {
    client.release();
  }
});

app.post("/api/thread/:token/reply", async (req, res) => {
  try {
    const { token } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Az üzenet nem lehet üres."
      });
    }

    const contactResult = await pool.query(
      `
      SELECT id, name, email
      FROM contact_messages
      WHERE thread_token = $1
      `,
      [token]
    );

    if (contactResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "A beszélgetés nem található."
      });
    }

    const contact = contactResult.rows[0];

    await pool.query(
      `
      INSERT INTO conversation_messages (contact_message_id, sender, message)
      VALUES ($1, $2, $3)
      `,
      [contact.id, "customer", message.trim()]
    );

    const fromEmail =
      process.env.CONTACT_FROM_EMAIL ||
      "Krilix Tech & Labs <hello@krilixtechlabs.com>";

    await resend.emails.send({
      from: fromEmail,
      to: process.env.CONTACT_TO_EMAIL,
      replyTo: contact.email,
      subject: `Új ügyfél válasz #${contact.id} - ${contact.name}`,
      html: customerThreadReplyEmail({
        name: escapeHtml(contact.name),
        email: escapeHtml(contact.email),
        message: escapeHtml(message).replace(/\n/g, "<br>"),
        adminUrl: `${BASE_URL}/admin`
      })
    });

    return res.status(200).json({
      ok: true,
      message: "Üzenet elküldve."
    });
  } catch (error) {
    console.error("Thread reply error:", error);

    return res.status(500).json({
      ok: false,
      error: "Nem sikerült elküldeni az üzenetet."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
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

    await pool.query(`
      ALTER TABLE contact_messages
      ADD COLUMN IF NOT EXISTS thread_token TEXT UNIQUE;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id SERIAL PRIMARY KEY,
        contact_message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    const missingTokens = await pool.query(`
      SELECT id
      FROM contact_messages
      WHERE thread_token IS NULL
    `);

    for (const row of missingTokens.rows) {
      const token = crypto.randomBytes(32).toString("hex");

      await pool.query(
        `
        UPDATE contact_messages
        SET thread_token = $1
        WHERE id = $2
        `,
        [token, row.id]
      );
    }

    const existingWithoutConversation = await pool.query(`
      SELECT cm.id, cm.message
      FROM contact_messages cm
      WHERE NOT EXISTS (
        SELECT 1
        FROM conversation_messages c
        WHERE c.contact_message_id = cm.id
      )
    `);

    for (const row of existingWithoutConversation.rows) {
      await pool.query(
        `
        INSERT INTO conversation_messages (contact_message_id, sender, message)
        VALUES ($1, $2, $3)
        `,
        [row.id, "customer", row.message]
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
    return res.status(401).json({
      ok: false,
      error: "Nincs jogosultság."
    });
  }

  next();
}

function createSessionToken() {
  const payload = {
    exp: Date.now() + 24 * 60 * 60 * 1000
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token) {
  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(encodedPayload)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false;
  }

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailShell({ title, label, content, dark = true }) {
  const bg = dark ? "#070707" : "#f4efe5";
  const card = dark ? "#151515" : "#ffffff";
  const text = dark ? "#f7f1e6" : "#111111";
  const muted = dark ? "#b8ad9b" : "#665f54";
  const border = dark ? "rgba(231,200,121,.35)" : "#ded3bd";

  return `
  <!doctype html>
  <html lang="hu">
  <body style="margin:0; padding:0; background:${bg}; font-family:Arial, Helvetica, sans-serif; color:${text};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg}; padding:36px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px; background:${card}; border:1px solid ${border};">
            <tr>
              <td style="padding:38px 36px 28px;">
                <div style="font-size:11px; letter-spacing:4px; text-transform:uppercase; color:#e7c879; font-weight:700;">
                  ${label}
                </div>

                <h1 style="margin:18px 0 0; font-family:Georgia, 'Times New Roman', serif; font-size:42px; line-height:1; font-weight:400; letter-spacing:-1.8px; color:${text};">
                  ${title}
                </h1>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px 34px; color:${muted}; font-size:16px; line-height:1.75;">
                ${content}
              </td>
            </tr>

            <tr>
              <td style="padding:22px 36px; border-top:1px solid rgba(231,200,121,.16); color:#8f8678; font-size:12px; line-height:1.6;">
                Krilix Tech & Labs — prémium weboldalak és működő webes megoldások.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function buttonHtml({ href, text }) {
  return `
    <div style="margin-top:26px;">
      <a href="${href}" style="display:inline-block; padding:15px 22px; background:#e7c879; color:#070707; text-decoration:none; font-size:14px; font-weight:700;">
        ${text}
      </a>
    </div>
  `;
}

function adminNewMessageEmail({ id, name, email, message, adminUrl, threadUrl }) {
  return emailShell({
    dark: false,
    label: "Krilix Tech & Labs",
    title: "Új megkeresés érkezett.",
    content: `
      <p style="margin:0 0 18px;">Azonosító: <strong>#${id}</strong></p>
      <p style="margin:0 0 8px;"><strong>Név:</strong> ${name}</p>
      <p style="margin:0 0 22px;"><strong>Email:</strong> <a href="mailto:${email}" style="color:#111;">${email}</a></p>

      <div style="padding:24px; background:#f4efe5; border:1px solid #ded3bd; color:#111;">
        <div style="margin-bottom:14px; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">Üzenet</div>
        ${message}
      </div>

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
    content: `
      <p style="margin:0 0 22px;">
        Megkaptuk az üzeneted. Átnézzük, és hamarosan visszajelzünk a következő lépésekkel.
      </p>

      <div style="padding:24px; background:#0c0c0c; border:1px solid rgba(231,200,121,.22); color:#f7f1e6;">
        <div style="margin-bottom:14px; color:#e7c879; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">Az elküldött üzeneted</div>
        ${message}
      </div>

      <p style="margin:24px 0 0;">
        A beszélgetést később ezen a privát linken tudod folytatni:
      </p>

      ${buttonHtml({ href: threadUrl, text: "Beszélgetés megnyitása" })}
    `
  });
}

function replyNotificationEmail({ name, reply, threadUrl }) {
  return emailShell({
    dark: true,
    label: "Krilix Tech & Labs",
    title: "Válasz érkezett.",
    content: `
      <p style="margin:0 0 22px;">
        Szia ${name}, válasz érkezett a megkeresésedre.
      </p>

      <div style="padding:24px; background:#0c0c0c; border:1px solid rgba(231,200,121,.22); color:#f7f1e6;">
        ${reply}
      </div>

      <p style="margin:24px 0 0;">
        A teljes beszélgetést itt tudod megnyitni és folytatni:
      </p>

      ${buttonHtml({ href: threadUrl, text: "Beszélgetés megnyitása" })}
    `
  });
}

function customerThreadReplyEmail({ name, email, message, adminUrl }) {
  return emailShell({
    dark: false,
    label: "Ügyfél válaszolt",
    title: "Új üzenet érkezett.",
    content: `
      <p style="margin:0 0 8px;"><strong>Név:</strong> ${name}</p>
      <p style="margin:0 0 22px;"><strong>Email:</strong> <a href="mailto:${email}" style="color:#111;">${email}</a></p>

      <div style="padding:24px; background:#f4efe5; border:1px solid #ded3bd; color:#111;">
        <div style="margin-bottom:14px; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">Üzenet</div>
        ${message}
      </div>

      ${buttonHtml({ href: adminUrl, text: "Megnyitás adminban" })}
    `
  });
}