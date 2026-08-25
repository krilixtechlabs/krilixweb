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

app.use(express.json({ limit: "5mb" }));
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

app.get("/ajanlat/:slug", (req, res) => {
  res.sendFile(path.join(publicPath, "quote.html"));
});

app.get("/ajanlat-preview/:id", (req, res) => {
  res.sendFile(path.join(publicPath, "quote.html"));
});

app.get("/adatkezeles", (req, res) => {
  res.sendFile(path.join(publicPath, "adatkezeles.html"));
});

adminAuth.mountRoutes(app);

// -----------------------------------------------------------------------------
// API - QUOTES / AJÁNLATOK
// -----------------------------------------------------------------------------

app.get("/api/admin/quotes", adminAuth.requirePermission("quotes.read"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, quote_code, slug, source_brief_id, client_name, client_company,
        client_email, title, total_price, currency, status, validity_days,
        published_at, accepted_at, accepted_name, accepted_email,
        view_count, first_viewed_at, last_viewed_at, created_at, updated_at
      FROM quotes
      ORDER BY updated_at DESC, created_at DESC
    `);

    return res.status(200).json({
      ok: true,
      quotes: result.rows.map(formatQuoteSummary)
    });
  } catch (error) {
    console.error("Admin quotes error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült betölteni az ajánlatokat." });
  }
});

app.get("/api/admin/quotes/:id", adminAuth.requirePermission("quotes.read"), async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM quotes WHERE id = $1`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Az ajánlat nem található." });
    return res.status(200).json({ ok: true, quote: formatQuoteDetail(result.rows[0], true) });
  } catch (error) {
    console.error("Admin quote detail error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült betölteni az ajánlatot." });
  }
});

app.post("/api/admin/quotes", adminAuth.requirePermission("quotes.write"), async (req, res) => {
  try {
    const quote = normalizeQuotePayload(req.body || {});
    if (!quote.clientName || !quote.title) {
      return res.status(400).json({ ok: false, error: "Az ügyfél neve és a projekt címe kötelező." });
    }

    const slug = await uniqueQuoteSlug(quote.slug || quote.clientCompany || quote.clientName);
    const totalPrice = quote.content.items.reduce((sum, item) => sum + Number(item.price || 0), 0);

    const result = await pool.query(
      `
      INSERT INTO quotes
        (slug, source_brief_id, client_name, client_company, client_email, title,
         total_price, currency, status, validity_days, content, created_by, updated_by,
         created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10::jsonb, $11, $11, NOW(), NOW())
      RETURNING *
      `,
      [
        slug,
        quote.sourceBriefId,
        quote.clientName,
        quote.clientCompany,
        quote.clientEmail,
        quote.title,
        totalPrice,
        quote.currency,
        quote.validityDays,
        JSON.stringify(quote.content),
        req.adminUser.id
      ]
    );

    const created = result.rows[0];
    const quoteCode = buildQuoteCode(created.id, created.created_at);
    const finalResult = await pool.query(
      `UPDATE quotes SET quote_code = $1 WHERE id = $2 RETURNING *`,
      [quoteCode, created.id]
    );

    if (quote.sourceBriefId) {
      await pool.query(
        `UPDATE project_briefs SET status = CASE WHEN status = 'new' THEN 'processing' ELSE status END, updated_at = NOW() WHERE id = $1`,
        [quote.sourceBriefId]
      ).catch(() => {});
    }

    await adminAuth.logAudit(req, "quote.created", "quote", created.id, {
      clientName: quote.clientName,
      totalPrice
    });

    return res.status(201).json({ ok: true, quote: formatQuoteDetail(finalResult.rows[0], true) });
  } catch (error) {
    if (error?.code === "23505") {
      return res.status(409).json({ ok: false, error: "Ez az ajánlat link már foglalt. Válassz másik URL azonosítót." });
    }
    console.error("Quote create error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült létrehozni az ajánlatot." });
  }
});

app.patch("/api/admin/quotes/:id", adminAuth.requirePermission("quotes.write"), async (req, res) => {
  try {
    const existingResult = await pool.query(`SELECT * FROM quotes WHERE id = $1`, [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ ok: false, error: "Az ajánlat nem található." });

    if (existing.status === "accepted") {
      return res.status(409).json({ ok: false, error: "Az elfogadott ajánlat már nem módosítható. Készíts másolatot vagy új ajánlatot." });
    }

    const quote = normalizeQuotePayload(req.body || {}, existing);
    if (!quote.clientName || !quote.title) {
      return res.status(400).json({ ok: false, error: "Az ügyfél neve és a projekt címe kötelező." });
    }

    let slug = normalizeSlug(quote.slug || existing.slug || quote.clientName);
    if (slug !== existing.slug) slug = await uniqueQuoteSlug(slug, existing.id);
    const totalPrice = quote.content.items.reduce((sum, item) => sum + Number(item.price || 0), 0);

    const result = await pool.query(
      `
      UPDATE quotes
      SET slug = $1,
          source_brief_id = $2,
          client_name = $3,
          client_company = $4,
          client_email = $5,
          title = $6,
          total_price = $7,
          currency = $8,
          validity_days = $9,
          content = $10::jsonb,
          updated_by = $11,
          updated_at = NOW()
      WHERE id = $12
      RETURNING *
      `,
      [slug, quote.sourceBriefId, quote.clientName, quote.clientCompany, quote.clientEmail,
       quote.title, totalPrice, quote.currency, quote.validityDays, JSON.stringify(quote.content),
       req.adminUser.id, req.params.id]
    );

    await adminAuth.logAudit(req, "quote.updated", "quote", req.params.id, {
      clientName: quote.clientName,
      totalPrice
    });

    return res.status(200).json({ ok: true, quote: formatQuoteDetail(result.rows[0], true) });
  } catch (error) {
    if (error?.code === "23505") {
      return res.status(409).json({ ok: false, error: "Ez az ajánlat link már foglalt." });
    }
    console.error("Quote update error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült menteni az ajánlatot." });
  }
});

app.post("/api/admin/quotes/:id/publish", adminAuth.requirePermission("quotes.publish"), async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE quotes
      SET status = 'published',
          published_at = COALESCE(published_at, NOW()),
          updated_by = $1,
          updated_at = NOW()
      WHERE id = $2 AND status <> 'accepted'
      RETURNING *
      `,
      [req.adminUser.id, req.params.id]
    );

    if (!result.rows[0]) {
      const exists = await pool.query(`SELECT status FROM quotes WHERE id = $1`, [req.params.id]);
      if (!exists.rows[0]) return res.status(404).json({ ok: false, error: "Az ajánlat nem található." });
      return res.status(409).json({ ok: false, error: "Az elfogadott ajánlat státusza már nem módosítható." });
    }

    if (result.rows[0].source_brief_id) {
      await pool.query(`UPDATE project_briefs SET status = 'offer_sent', updated_at = NOW() WHERE id = $1`, [result.rows[0].source_brief_id]).catch(() => {});
    }

    await adminAuth.logAudit(req, "quote.published", "quote", req.params.id, {
      slug: result.rows[0].slug
    });

    return res.status(200).json({ ok: true, quote: formatQuoteDetail(result.rows[0], true) });
  } catch (error) {
    console.error("Quote publish error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült publikálni az ajánlatot." });
  }
});

app.post("/api/admin/quotes/:id/unpublish", adminAuth.requirePermission("quotes.publish"), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE quotes SET status = 'draft', updated_by = $1, updated_at = NOW() WHERE id = $2 AND status = 'published' RETURNING *`,
      [req.adminUser.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(409).json({ ok: false, error: "Csak publikált, még el nem fogadott ajánlat vonható vissza." });
    await adminAuth.logAudit(req, "quote.unpublished", "quote", req.params.id);
    return res.status(200).json({ ok: true, quote: formatQuoteDetail(result.rows[0], true) });
  } catch (error) {
    console.error("Quote unpublish error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült visszavonni az ajánlatot." });
  }
});

app.post("/api/admin/quotes/:id/duplicate", adminAuth.requirePermission("quotes.write"), async (req, res) => {
  try {
    const existingResult = await pool.query(`SELECT * FROM quotes WHERE id = $1`, [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ ok: false, error: "Az ajánlat nem található." });

    const slug = await uniqueQuoteSlug(`${existing.slug}-masolat`);
    const result = await pool.query(
      `
      INSERT INTO quotes
        (slug, source_brief_id, client_name, client_company, client_email, title, total_price,
         currency, status, validity_days, content, created_by, updated_by, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$11,NOW(),NOW())
      RETURNING *
      `,
      [slug, existing.source_brief_id, existing.client_name, existing.client_company, existing.client_email,
       existing.title, existing.total_price, existing.currency, existing.validity_days, existing.content, req.adminUser.id]
    );
    const created=result.rows[0];
    const quoteCode=buildQuoteCode(created.id,created.created_at);
    const updated=await pool.query(`UPDATE quotes SET quote_code=$1 WHERE id=$2 RETURNING *`,[quoteCode,created.id]);
    await adminAuth.logAudit(req,"quote.duplicated","quote",created.id,{sourceQuoteId:existing.id});
    return res.status(201).json({ok:true,quote:formatQuoteDetail(updated.rows[0],true)});
  } catch (error) {
    console.error("Quote duplicate error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült másolni az ajánlatot." });
  }
});

app.delete("/api/admin/quotes/:id", adminAuth.requirePermission("quotes.delete"), async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM quotes WHERE id = $1 AND status <> 'accepted' RETURNING id`, [req.params.id]);
    if (!result.rows[0]) {
      const exists = await pool.query(`SELECT status FROM quotes WHERE id = $1`, [req.params.id]);
      if (!exists.rows[0]) return res.status(404).json({ ok: false, error: "Az ajánlat nem található." });
      return res.status(409).json({ ok: false, error: "Elfogadott ajánlat nem törölhető." });
    }
    await adminAuth.logAudit(req, "quote.deleted", "quote", req.params.id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Quote delete error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült törölni az ajánlatot." });
  }
});

app.get("/api/quote/:slug", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM quotes WHERE slug = $1 AND status IN ('published','accepted')`, [normalizeSlug(req.params.slug)]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "Az ajánlat nem található vagy még nincs publikálva." });

    await pool.query(
      `UPDATE quotes SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, NOW()), last_viewed_at = NOW() WHERE id = $1`,
      [row.id]
    ).catch(() => {});

    return res.status(200).json({ ok: true, quote: formatQuoteDetail(row, false) });
  } catch (error) {
    console.error("Public quote error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült betölteni az ajánlatot." });
  }
});

app.post("/api/quote/:slug/accept", async (req, res) => {
  const client = await pool.connect();
  try {
    const name = String(req.body?.name || "").trim().slice(0, 120);
    const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 180);
    const acceptTerms = req.body?.acceptTerms === true;

    if (!name || !isReasonableEmail(email) || !acceptTerms) {
      return res.status(400).json({ ok: false, error: "Név, érvényes e-mail és a feltételek elfogadása szükséges." });
    }

    await client.query("BEGIN");
    const quoteResult = await client.query(`SELECT * FROM quotes WHERE slug = $1 FOR UPDATE`, [normalizeSlug(req.params.slug)]);
    const quote = quoteResult.rows[0];
    if (!quote || !["published", "accepted"].includes(quote.status)) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Az ajánlat nem található vagy nem fogadható el." });
    }
    if (quote.status === "accepted") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Ezt az ajánlatot már elfogadták." });
    }
    if (quoteIsExpired(quote)) {
      await client.query("ROLLBACK");
      return res.status(410).json({ ok: false, error: "Az ajánlat érvényességi ideje lejárt." });
    }

    const acceptedAt = new Date();
    await client.query(
      `
      INSERT INTO quote_acceptances
        (quote_id, name, email, accepted_at, ip_address, user_agent, quote_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      `,
      [quote.id, name, email, acceptedAt, clientIpAddress(req), cleanOptional(req.headers["user-agent"]), JSON.stringify(formatQuoteDetail(quote, false))]
    );

    const updatedResult = await client.query(
      `
      UPDATE quotes
      SET status = 'accepted', accepted_at = $1, accepted_name = $2, accepted_email = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [acceptedAt, name, email, quote.id]
    );

    if (quote.source_brief_id) {
      await client.query(`UPDATE project_briefs SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [quote.source_brief_id]);
    }

    await client.query("COMMIT");

    const updated = updatedResult.rows[0];
    sendQuoteAcceptedEmails(updated, { name, email }).catch(error => console.error("Quote acceptance email error:", error));

    return res.status(200).json({ ok: true, quote: formatQuoteDetail(updated, false) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Quote accept error:", error);
    return res.status(500).json({ ok: false, error: "Nem sikerült rögzíteni az ajánlat elfogadását." });
  } finally {
    client.release();
  }
});


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



    await pool.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        quote_code TEXT UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        source_brief_id INTEGER REFERENCES project_briefs(id) ON DELETE SET NULL,
        client_name TEXT NOT NULL,
        client_company TEXT,
        client_email TEXT,
        title TEXT NOT NULL,
        total_price INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'Ft',
        status TEXT NOT NULL DEFAULT 'draft',
        validity_days INTEGER NOT NULL DEFAULT 14,
        content JSONB NOT NULL DEFAULT '{}'::jsonb,
        published_at TIMESTAMP,
        accepted_at TIMESTAMP,
        accepted_name TEXT,
        accepted_email TEXT,
        view_count INTEGER NOT NULL DEFAULT 0,
        first_viewed_at TIMESTAMP,
        last_viewed_at TIMESTAMP,
        created_by INTEGER,
        updated_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS quotes_slug_lower_unique ON quotes (LOWER(slug));`);
    await pool.query(`CREATE INDEX IF NOT EXISTS quotes_status_updated_idx ON quotes(status, updated_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS quotes_source_brief_idx ON quotes(source_brief_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quote_acceptances (
        id BIGSERIAL PRIMARY KEY,
        quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        accepted_at TIMESTAMP NOT NULL DEFAULT NOW(),
        ip_address TEXT,
        user_agent TEXT,
        quote_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS quote_acceptances_quote_idx ON quote_acceptances(quote_id, accepted_at DESC);`);

    const vibeQuoteCount = await pool.query(`SELECT COUNT(*)::int AS count FROM quotes WHERE slug = 'vibehouse'`);
    if ((vibeQuoteCount.rows[0]?.count || 0) === 0) {
      const vibeContent = defaultVibeHouseQuoteContent();
      const vibeItems = vibeContent.items || [];
      const vibeTotal = vibeItems.reduce((sum, item) => sum + Number(item.price || 0), 0);
      const inserted = await pool.query(
        `
        INSERT INTO quotes
          (slug, client_name, client_company, title, total_price, currency, status,
           validity_days, content, published_at, created_at, updated_at)
        VALUES ('vibehouse','Vibe House','Vibe House','Vibe House weboldal',$1,'Ft','published',14,$2::jsonb,NOW(),NOW(),NOW())
        RETURNING id, created_at
        `,
        [vibeTotal, JSON.stringify(vibeContent)]
      );
      const row = inserted.rows[0];
      await pool.query(`UPDATE quotes SET quote_code = $1 WHERE id = $2`, [buildQuoteCode(row.id, row.created_at), row.id]);
      console.log("Vibe House mintaajánlat létrehozva az Ajánlatok modulban.");
    }

    console.log("Database ready.");
  } catch (error) {
    console.error("Database init error:", error);
  }
}



function normalizeQuotePayload(body, existing = null) {
  const previous = existing?.content && typeof existing.content === "object" ? existing.content : {};
  const sourceBriefId = body.sourceBriefId === null || body.sourceBriefId === "" ? null : Number(body.sourceBriefId || existing?.source_brief_id || 0) || null;
  const clientName = cleanQuoteText(body.clientName ?? existing?.client_name, 160);
  const clientCompany = cleanQuoteText(body.clientCompany ?? existing?.client_company, 180);
  const clientEmail = cleanQuoteText(body.clientEmail ?? existing?.client_email, 180).toLowerCase();
  const title = cleanQuoteText(body.title ?? existing?.title ?? clientName, 220);
  const currency = cleanQuoteText(body.currency ?? existing?.currency ?? "Ft", 12) || "Ft";
  const validityDays = clampInteger(body.validityDays ?? existing?.validity_days ?? 14, 1, 120, 14);

  const rawContent = body.content && typeof body.content === "object" ? body.content : previous;
  const content = {
    eyebrow: cleanQuoteText(rawContent.eyebrow ?? previous.eyebrow ?? "Személyre szabott ajánlat", 120),
    accent: safeHexColor(rawContent.accent ?? previous.accent ?? "#D94E87"),
    clientLogo: safeQuoteLogo(rawContent.clientLogo ?? previous.clientLogo ?? ""),
    projectTitle: cleanQuoteText(rawContent.projectTitle ?? previous.projectTitle ?? clientName, 180),
    projectAccent: cleanQuoteText(rawContent.projectAccent ?? previous.projectAccent ?? "weboldal", 140),
    description: cleanQuoteText(rawContent.description ?? previous.description ?? "", 1400),
    overviewTitle: cleanQuoteText(rawContent.overviewTitle ?? previous.overviewTitle ?? "Projekt áttekintése,", 180),
    overviewAccent: cleanQuoteText(rawContent.overviewAccent ?? previous.overviewAccent ?? "röviden.", 140),
    overviewDescription: cleanQuoteText(rawContent.overviewDescription ?? previous.overviewDescription ?? "", 2200),
    duration: cleanQuoteText(rawContent.duration ?? previous.duration ?? "2–3 hét", 80),
    payment: cleanQuoteText(rawContent.payment ?? previous.payment ?? "100% a végleges átadáskor", 180),
    features: normalizeQuoteCollection(rawContent.features, 12, normalizeQuoteFeature),
    items: normalizeQuoteCollection(rawContent.items, 20, normalizeQuoteItem),
    timeline: normalizeQuoteCollection(rawContent.timeline, 8, normalizeQuoteTimeline),
    terms: normalizeQuoteCollection(rawContent.terms, 8, normalizeQuoteTerm),
    acceptance: normalizeQuoteAcceptance(rawContent.acceptance ?? previous.acceptance)
  };

  if (!content.items.length && Array.isArray(previous.items)) {
    content.items = normalizeQuoteCollection(previous.items, 20, normalizeQuoteItem);
  }

  return {
    sourceBriefId,
    clientName,
    clientCompany,
    clientEmail,
    title,
    currency,
    validityDays,
    slug: normalizeSlug(body.slug ?? existing?.slug ?? clientCompany ?? clientName),
    content
  };
}

function normalizeQuoteCollection(value, max, mapper) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(mapper).filter(item => item && (item.title || item.label));
}

function normalizeQuoteFeature(item) {
  if (!item || typeof item !== "object") return null;
  return {
    title: cleanQuoteText(item.title, 120),
    description: cleanQuoteText(item.description, 700),
    accent: item.accent === true
  };
}

function normalizeQuoteItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    title: cleanQuoteText(item.title, 180),
    description: cleanQuoteText(item.description, 700),
    price: clampInteger(item.price, 0, 100000000, 0),
    accent: item.accent === true
  };
}

function normalizeQuoteTimeline(item) {
  if (!item || typeof item !== "object") return null;
  return {
    title: cleanQuoteText(item.title, 120),
    description: cleanQuoteText(item.description, 700),
    accent: item.accent === true
  };
}

function normalizeQuoteTerm(item) {
  if (!item || typeof item !== "object") return null;
  return {
    label: cleanQuoteText(item.label, 100),
    title: cleanQuoteText(item.title, 180),
    description: cleanQuoteText(item.description, 800)
  };
}

function normalizeQuoteAcceptance(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    enabled: item.enabled !== false,
    title: cleanQuoteText(item.title || "Indulhat a", 120),
    accent: cleanQuoteText(item.accent || "projekt.", 120),
    description: cleanQuoteText(item.description || "Az ajánlat elfogadása után egyeztetjük a következő lépéseket.", 1000)
  };
}

function cleanQuoteText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function clampInteger(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function safeHexColor(value) {
  const text = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : "#D94E87";
}

function safeQuoteLogo(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("/quote-assets/") || text.startsWith("https://") || text.startsWith("http://")) return text.slice(0, 5000);
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(text) && text.length <= 3_500_000) return text;
  return "";
}

function normalizeSlug(value) {
  const source = String(value || "ajanlat").trim().toLowerCase();
  return source
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ajanlat";
}

async function uniqueQuoteSlug(value, excludeId = null) {
  const base = normalizeSlug(value);
  let candidate = base;
  for (let index = 1; index < 1000; index += 1) {
    const params = excludeId ? [candidate, excludeId] : [candidate];
    const sql = excludeId
      ? `SELECT 1 FROM quotes WHERE LOWER(slug) = LOWER($1) AND id <> $2 LIMIT 1`
      : `SELECT 1 FROM quotes WHERE LOWER(slug) = LOWER($1) LIMIT 1`;
    const exists = await pool.query(sql, params);
    if (!exists.rows.length) return candidate;
    candidate = `${base}-${index + 1}`;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function buildQuoteCode(id, dateValue) {
  const year = new Date(dateValue || Date.now()).getFullYear();
  return `AJ-${year}-${String(id).padStart(4, "0")}`;
}

function quoteIsExpired(row) {
  if (!row?.published_at || row.status === "accepted") return false;
  const days = clampInteger(row.validity_days, 1, 120, 14);
  return Date.now() > new Date(row.published_at).getTime() + days * 86400000;
}

function formatQuoteSummary(row) {
  return {
    id: row.id,
    quoteCode: row.quote_code,
    slug: row.slug,
    sourceBriefId: row.source_brief_id,
    clientName: row.client_name,
    clientCompany: row.client_company,
    clientEmail: row.client_email,
    title: row.title,
    totalPrice: Number(row.total_price || 0),
    currency: row.currency || "Ft",
    status: row.status,
    validityDays: Number(row.validity_days || 14),
    publishedAt: row.published_at,
    acceptedAt: row.accepted_at,
    acceptedName: row.accepted_name,
    acceptedEmail: row.accepted_email,
    viewCount: Number(row.view_count || 0),
    firstViewedAt: row.first_viewed_at,
    lastViewedAt: row.last_viewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isExpired: quoteIsExpired(row)
  };
}

function formatQuoteDetail(row, isAdmin) {
  const summary = formatQuoteSummary(row);
  const detail = {
    ...summary,
    content: row.content && typeof row.content === "object" ? row.content : {},
    publicUrl: `${BASE_URL}/ajanlat/${row.slug}`,
    previewUrl: isAdmin ? `${BASE_URL}/ajanlat-preview/${row.id}` : undefined
  };

  if (!isAdmin) {
    delete detail.clientEmail;
    delete detail.acceptedName;
    delete detail.acceptedEmail;
  }

  return detail;
}

function isReasonableEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function clientIpAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.ip || req.socket?.remoteAddress || "").slice(0, 120);
}

async function sendQuoteAcceptedEmails(quote, acceptedBy) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === "missing-key" || !process.env.CONTACT_TO_EMAIL) return;
  const publicUrl = `${BASE_URL}/ajanlat/${quote.slug}`;
  const amount = new Intl.NumberFormat("hu-HU").format(Number(quote.total_price || 0));
  const from = getFromEmail();

  await resend.emails.send({
    from,
    to: process.env.CONTACT_TO_EMAIL,
    subject: `Ajánlat elfogadva: ${quote.client_name} — ${amount} ${quote.currency || "Ft"}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:32px;background:#0b0e0f;color:#f4efe6">
        <div style="color:#d7af55;font-size:12px;letter-spacing:2px">KRILIX TECH & LABS</div>
        <h1 style="font-size:34px;margin:18px 0">Ajánlat elfogadva.</h1>
        <p><strong>Ügyfél:</strong> ${escapeHtml(quote.client_name)}</p>
        <p><strong>Elfogadta:</strong> ${escapeHtml(acceptedBy.name)} (${escapeHtml(acceptedBy.email)})</p>
        <p><strong>Projekt díja:</strong> ${amount} ${escapeHtml(quote.currency || "Ft")}</p>
        <p><a href="${publicUrl}" style="color:#d7af55">Ajánlat megnyitása →</a></p>
      </div>`
  });

  await resend.emails.send({
    from,
    to: acceptedBy.email,
    subject: `Ajánlat elfogadása rögzítve — ${quote.client_name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:32px;background:#0b0e0f;color:#f4efe6">
        <div style="color:#d7af55;font-size:12px;letter-spacing:2px">KRILIX TECH & LABS</div>
        <h1 style="font-size:34px;margin:18px 0">Köszönjük az elfogadást.</h1>
        <p>Rögzítettük a <strong>${amount} ${escapeHtml(quote.currency || "Ft")}</strong> összegű ajánlat elfogadását.</p>
        <p>A következő lépésekkel hamarosan jelentkezünk.</p>
        <p><a href="${publicUrl}" style="color:#d7af55">Ajánlat megnyitása →</a></p>
      </div>`
  });
}

function defaultVibeHouseQuoteContent() {
  return {
    eyebrow: "Személyre szabott ajánlat",
    accent: "#D94E87",
    clientLogo: "/quote-assets/vibehouse-logo.png",
    projectTitle: "Vibe House",
    projectAccent: "weboldal",
    description: "Modern, mobilra optimalizált weboldal eseményekkel, galériával, kapcsolati felülettel és saját admin rendszerrel.",
    overviewTitle: "Egy egyszerű oldal,",
    overviewAccent: "ami él.",
    overviewDescription: "A cél egy olyan karakteres Vibe House weboldal, ami nem csak bemutatkozó oldal: az események, hírek és galéria tartalma admin felületről frissíthető.",
    duration: "2–3 hét",
    payment: "100% a végleges átadáskor",
    features: [
      { title: "Főoldal", description: "Erős vizuális belépő, következő bulik, aktuális tartalmak és gyors navigáció." },
      { title: "Események", description: "Közelgő bulik dátummal, helyszínnel, képpel és részletekkel." },
      { title: "Blog / hírek", description: "Bejegyzések és közlemények, amelyeket saját adminból lehet publikálni." },
      { title: "Galéria", description: "Mobilbarát képgaléria korábbi eseményekhez és hangulatképekhez." },
      { title: "Kapcsolat", description: "Kapcsolati információk, közösségi linkek és egyszerű kapcsolatfelvétel." },
      { title: "Admin", description: "Jelszóval védett felület új események és bejegyzések kezelésére.", accent: true }
    ],
    items: [
      { title: "UI/UX + reszponzív design", description: "Oldalstruktúra, mobilos és asztali megjelenés", price: 25000 },
      { title: "Főoldal + galéria + kapcsolat", description: "Oldalak felépítése és frontend fejlesztése", price: 30000 },
      { title: "Események / hírek + admin", description: "Tartalomkezelés, új poszt és esemény létrehozás", price: 60000, accent: true },
      { title: "SEO + tesztelés + élesítés", description: "Alap technikai SEO, tesztelés, publikálás", price: 25000 }
    ],
    timeline: [
      { title: "Indítás", description: "Igények véglegesítése, tartalmak és hozzáférések átadása." },
      { title: "Első verzió", description: "Design és működő oldalak bemutatása, első visszajelzési kör.", accent: true },
      { title: "Élesítés", description: "Finomhangolás, admin átadás és publikálás." }
    ],
    terms: [
      { label: "Utókövetés", title: "30 nap hibajavítás", description: "Az átadást követően, a projektár részeként." },
      { label: "Külső költség", title: "Domain + tárhely / szerver", description: "A megrendelő saját költsége, nem része a projekt díjának." }
    ],
    acceptance: {
      enabled: true,
      title: "Indulhat a",
      accent: "Vibe House.",
      description: "Az ajánlat elfogadása után egyeztetjük a szükséges tartalmakat, hozzáféréseket és indulhat a kivitelezés."
    }
  };
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
