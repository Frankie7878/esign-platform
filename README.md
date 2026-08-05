# ✍️ E-Sign Platform

> A modern, secure, DocuSign-style multi-party electronic signature platform built with Node.js, PDF.js, `pdf-lib`, and PKCS#12 digital audit certificates.

---

## ✨ Features

- 📄 **Multi-PDF Package Upload & Merging**: Upload multiple PDF documents (e.g. Lease Agreement + Addendum) simultaneously in a single envelope. Backend automatically merges them into a unified master document package.
- 🎨 **DocuSign-Style Sender Designer**: Interactive 2-step setup wizard. Senders can add multiple recipients with dedicated color badges and drag/click to place pre-assigned fields (`Signature`, `Initials`, `Date`, `Text`).
- 🎯 **Guided Signer Experience with "NEXT ➔" Arrow**: Interactive guided signing desk with a DocuSign-style floating `NEXT ➔` navigation button. Smoothly scrolls the viewport to center the next uncompleted field with glowing focus rings and auto-advances after filling.
- 📱 **Full Mobile Touch Screen Support**: Touch-enabled signature canvas supporting hand-drawn signatures and typed scripts on iOS Safari and Android Chrome.
- 🛠️ **Memory PDF Auto-Repair Engine**: Built-in automatic page tree recovery for PDFs with missing/corrupted object dictionaries or DRM encryption flags.
- 🔒 **Cryptographic Digital Audit Certificates**: Appends a Certificate of Completion audit page with timestamp/IP logs and signs the PDF with a PKCS#12 digital signature.
- 📧 **Automatic Final Distribution**: Distributes completed, tamper-evident signed PDFs to all signers and the sender upon completion.

---

## 🛠️ Technology Stack

- **Backend**: Node.js (ES Modules), Express.js, `pdf-lib`, `@signpdf/signpdf`, `nodemailer`, `multer`, `node-forge`
- **Frontend**: HTML5, Vanilla JavaScript, TailwindCSS, PDF.js

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/Frankie7878/esign-platform.git
cd esign-platform
npm install
```

### 2. Configuration
Create or update `config.mjs` with your SMTP email credentials and public server URL:

```javascript
export const CONFIG = {
    // Gmail Credentials (use App Password)
    EMAIL_USER: "your-email@gmail.com",
    EMAIL_PASS: "your-app-password",

    // Public URL (Ngrok or Production domain)
    BASE_URL: "https://your-ngrok-subdomain.ngrok-free.dev"
};
```

### 3. Run Server
```bash
npm start
```

### 4. Start Ngrok Tunnel (Optional for Remote Signers)
```bash
ngrok http 3000 --url=your-ngrok-subdomain.ngrok-free.dev
```

Open `http://localhost:3000` in your browser to access the E-Sign Desk.

---

## 📄 License
MIT License
