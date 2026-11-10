'use strict';
// Sends the one-time codes by email.
//  - SMTP_USER + SMTP_PASS set  -> real email (Gmail App Password works)
//  - MAIL_STUB=1                -> keeps mails in memory (used by tests)
// Returns true when something was sent, false when email is not configured.

let transporter = null;

function mailBody(purpose, code, name) {
  const what = purpose === 'reset' ? 'reset your password' : 'verify your email';
  const text =
    `Hi ${name || 'there'},\n\nYour Attendly code to ${what} is:\n\n    ${code}\n\n` +
    `It works for 10 minutes. If you did not ask for it, ignore this email. Nobody can use the code without your password.\n\nAttendly`;
  const html =
    `<div style="font-family:Arial,sans-serif;color:#1A2B3C;background:#F7FAFC;padding:24px">` +
    `<p>Hi ${String(name || 'there').replace(/[<>&]/g, '')},</p>` +
    `<p>Your Attendly code to ${what} is:</p>` +
    `<p style="font-size:32px;font-weight:800;letter-spacing:8px;margin:16px 0">${code}</p>` +
    `<p>It works for 10 minutes. If you did not ask for it, ignore this email.</p></div>`;
  return { text, html };
}

async function sendOtpMail({ to, purpose, code, name }) {
  const subject = purpose === 'reset' ? 'Reset your Attendly password' : 'Verify your Attendly email';
  const { text, html } = mailBody(purpose, code, name);
  if (process.env.MAIL_STUB) {
    (global.__mailbox = global.__mailbox || []).push({ to, subject, text });
    return true;
  }
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return false;
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  transporter =
    transporter ||
    nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  await transporter.sendMail({ from: `Attendly <${process.env.MAIL_FROM || user}>`, to, subject, text, html });
  return true;
}

module.exports = { sendOtpMail };
