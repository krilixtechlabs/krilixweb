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
    const fromEmail = process.env.CONTACT_FROM_EMAIL || "Krilix Tech & Labs <onboarding@resend.dev>";

    if (!toEmail) {
      return res.status(500).json({
        ok: false,
        error: "Hiányzik a CONTACT_TO_EMAIL."
      });
    }

    await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      replyTo: email,
      subject: `Új megkeresés - ${name}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
          <h2>Új megkeresés érkezett a Krilix weboldalról</h2>

          <p><strong>Név:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>

          <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;">

          <p><strong>Üzenet:</strong></p>
          <p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>
        </div>
      `
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
