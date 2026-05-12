const express = require("express");
const path = require("path");
const { Resend } = require("resend");

const app = express();

const PORT = process.env.PORT || 3000;
const publicPath = path.join(__dirname, "public");

const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
app.use(express.static(publicPath));

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

    const toEmail = process.env.CONTACT_TO_EMAIL;
    const fromEmail = process.env.CONTACT_FROM_EMAIL || "Krilix Tech & Labs <hello@krilixtechlabs.com>";

    if (!toEmail) {
      return res.status(500).json({
        ok: false,
        error: "Hiányzik a CONTACT_TO_EMAIL."
      });
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");

    await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      replyTo: email,
      subject: `Új megkeresés - ${name}`,
      html: adminEmailTemplate({
        name: safeName,
        email: safeEmail,
        message: safeMessage
      })
    });

    await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: "Megkaptuk az üzeneted - Krilix Tech & Labs",
      html: customerEmailTemplate({
        name: safeName,
        message: safeMessage
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

app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Krilix site is running on port ${PORT}`);
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function adminEmailTemplate({ name, email, message }) {
  return `
  <!doctype html>
  <html lang="hu">
  <head>
    <meta charset="utf-8">
  </head>
  <body style="margin:0; padding:0; background:#f4efe5; font-family:Arial, Helvetica, sans-serif; color:#111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4efe5; padding:36px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px; background:#ffffff; border:1px solid #ded3bd;">
            <tr>
              <td style="padding:34px 36px 26px; background:#080808; color:#f7f1e6;">
                <div style="font-size:11px; letter-spacing:4px; text-transform:uppercase; color:#e7c879; font-weight:700;">
                  Krilix Tech & Labs
                </div>
                <h1 style="margin:18px 0 0; font-family:Georgia, 'Times New Roman', serif; font-size:38px; line-height:1; font-weight:400; letter-spacing:-1.5px;">
                  Új megkeresés érkezett.
                </h1>
              </td>
            </tr>

            <tr>
              <td style="padding:34px 36px;">
                <p style="margin:0 0 24px; color:#665f54; font-size:16px; line-height:1.7;">
                  Valaki kitöltötte a Krilix weboldal kapcsolatfelvételi űrlapját.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="padding:16px 0; border-top:1px solid #e6ddcd; width:140px; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">
                      Név
                    </td>
                    <td style="padding:16px 0; border-top:1px solid #e6ddcd; font-size:16px;">
                      ${name}
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:16px 0; border-top:1px solid #e6ddcd; width:140px; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">
                      Email
                    </td>
                    <td style="padding:16px 0; border-top:1px solid #e6ddcd; font-size:16px;">
                      <a href="mailto:${email}" style="color:#111; text-decoration:underline;">${email}</a>
                    </td>
                  </tr>
                </table>

                <div style="margin-top:28px; padding:24px; background:#f4efe5; border:1px solid #ded3bd;">
                  <div style="margin-bottom:14px; color:#8a6a2c; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">
                    Üzenet
                  </div>
                  <div style="font-size:16px; line-height:1.75; color:#111;">
                    ${message}
                  </div>
                </div>

                <div style="margin-top:30px;">
                  <a href="mailto:${email}" style="display:inline-block; padding:15px 22px; background:#080808; color:#f7f1e6; text-decoration:none; font-size:14px; font-weight:700;">
                    Válasz küldése
                  </a>
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:22px 36px; background:#f7f1e6; color:#8f8678; font-size:12px; line-height:1.6;">
                Ez az email automatikusan érkezett a krilixtechlabs.com kapcsolatfelvételi űrlapjáról.
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

function customerEmailTemplate({ name, message }) {
  return `
  <!doctype html>
  <html lang="hu">
  <head>
    <meta charset="utf-8">
  </head>
  <body style="margin:0; padding:0; background:#070707; font-family:Arial, Helvetica, sans-serif; color:#f7f1e6;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070707; padding:36px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px; background:#151515; border:1px solid rgba(231,200,121,.35);">
            <tr>
              <td style="padding:38px 36px 28px; text-align:center;">
                <div style="margin:0 auto 24px; width:82px; height:82px; border-radius:50%; border:1px solid rgba(231,200,121,.45); display:table;">
                  <div style="display:table-cell; vertical-align:middle; text-align:center; color:#e7c879; font-family:Georgia, 'Times New Roman', serif; font-size:20px; font-weight:700;">
                    KRILIX
                  </div>
                </div>

                <div style="font-size:11px; letter-spacing:4px; text-transform:uppercase; color:#e7c879; font-weight:700;">
                  Üzenet megérkezett
                </div>

                <h1 style="margin:18px 0 0; font-family:Georgia, 'Times New Roman', serif; font-size:42px; line-height:1; font-weight:400; letter-spacing:-1.8px; color:#fffaf0;">
                  Köszönjük, ${name}.
                </h1>

                <p style="margin:22px auto 0; max-width:460px; color:#b8ad9b; font-size:16px; line-height:1.75;">
                  Megkaptuk az üzeneted. Átnézzük, és hamarosan visszajelzünk a következő lépésekkel.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px 34px;">
                <div style="padding:24px; background:#0c0c0c; border:1px solid rgba(231,200,121,.22);">
                  <div style="margin-bottom:14px; color:#e7c879; font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">
                    Az elküldött üzeneted
                  </div>
                  <div style="font-size:15px; line-height:1.75; color:#f7f1e6;">
                    ${message}
                  </div>
                </div>

                <p style="margin:24px 0 0; color:#a99f90; font-size:14px; line-height:1.7;">
                  Ha valamit még hozzátennél, egyszerűen válaszolj erre az emailre.
                </p>
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
