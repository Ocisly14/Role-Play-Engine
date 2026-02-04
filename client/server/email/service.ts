import nodemailer from 'nodemailer';
import handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const emailService = {
  // Send verification code email
  async sendVerificationEmail(to: string, code: string) {
    const template = await this.loadTemplate('verify-email');
    const html = template({ verificationCode: code, appName: 'Talecraft Game' });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: 'Your Verification Code',
      html,
    });
  },

  // Send password reset email
  async sendPasswordResetEmail(to: string, token: string) {
    const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;

    const template = await this.loadTemplate('reset-password');
    const html = template({ resetUrl, appName: 'Talecraft Game' });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: 'Reset Your Password',
      html,
    });
  },

  // Load email template
  async loadTemplate(name: string) {
    const templatePath = path.join(__dirname, 'templates', `${name}.hbs`);
    const templateContent = await fs.readFile(templatePath, 'utf-8');
    return handlebars.compile(templateContent);
  },
};
