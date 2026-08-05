import express from 'express';
import cors from "cors";
import multer from 'multer';
import { PDFDocument, rgb, StandardFonts, PDFName, PDFDict, PDFPageTree } from 'pdf-lib';
import fs from 'fs';
import forge from 'node-forge';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';

// --- IMPORT CONFIG ---
import { CONFIG } from './config.mjs';

// --- IMPORTS FOR DIGITAL SIGNING ---
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// ⚠️ USE CONFIG FILE FOR CREDENTIALS
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS }
});

// --- DATABASE HELPERS ---
function getDb() {
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { return {}; }
}
function saveEnvelope(id, data) {
    const db = getDb();
    db[id] = data;
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function getEnvelope(id) { return getDb()[id]; }
function deleteEnvelope(id) {
    const db = getDb();
    delete db[id];
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function repairPdfPageTree(doc) {
    try {
        doc.getPages();
    } catch (e) {
        console.warn("🛠️ Auto-repairing corrupted PDF page tree...", e.message);
        try {
            const validRefs = [];
            doc.context.enumerateIndirectObjects().forEach(([ref, obj]) => {
                if (obj instanceof PDFDict) {
                    const type = obj.get(PDFName.of("Type"));
                    if (type && type.toString() === "/Page") {
                        validRefs.push(ref);
                    }
                }
            });

            if (validRefs.length > 0) {
                const kidsArray = doc.context.obj(validRefs);
                const pagesDict = doc.context.obj({
                    Type: "Pages",
                    Count: validRefs.length,
                    Kids: kidsArray
                });
                const pageTree = PDFPageTree.fromMapWithContext(pagesDict, doc.context);
                const pagesRef = doc.context.register(pageTree);

                validRefs.forEach(ref => {
                    const pageObj = doc.context.lookup(ref);
                    if (pageObj instanceof PDFDict) {
                        pageObj.set(PDFName.of("Parent"), pagesRef);
                    }
                });

                doc.catalog.set(PDFName.of("Pages"), pagesRef);
                console.log(`✅ Successfully repaired corrupted PDF page tree (${validRefs.length} pages recovered)!`);
            }
        } catch (repairErr) {
            console.error("Failed to auto-repair page tree:", repairErr);
        }
    }
}

// --- IDENTITY (Self-Signed Cert) ---
let p12Buffer;
function generateIdentity() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: 'commonName', value: 'My Custom E-Sign' }];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, 'password', { algorithm: '3des' });
    p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}
generateIdentity();

const upload = multer({ dest: 'uploads/' });
app.use(express.static('public'));

// ======================================================
// 1. START: UPLOAD MULTI-PDF & START CHAIN
// ======================================================
app.post('/api/send', upload.array('pdf'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) throw new Error("No PDF documents uploaded");

        const clients = JSON.parse(req.body.clients || '[]');
        const senderName = req.body.senderName;
        const senderEmail = req.body.senderEmail;
        const includeSender = req.body.includeSender === 'true'; 
        const assignedFields = JSON.parse(req.body.assignedFields || '[]');
        
        const envelopeId = Math.random().toString(36).substring(2, 10).toUpperCase();
        const fileNames = [];
        const masterFilePath = path.join('uploads', `envelope_${envelopeId}.pdf`);

        if (req.files.length === 1) {
            // Single PDF: Copy file directly to avoid page tree reconstruction issues on protected PDFs
            const singleFile = req.files[0];
            fileNames.push(singleFile.originalname);
            fs.copyFileSync(singleFile.path, masterFilePath);
            try { fs.unlinkSync(singleFile.path); } catch(e){}
        } else {
            // Multiple PDFs: Merge sequentially using pdf-lib
            const mergedPdfDoc = await PDFDocument.create();
            for (const file of req.files) {
                fileNames.push(file.originalname);
                const pdfBytes = fs.readFileSync(file.path);
                try {
                    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
                    repairPdfPageTree(doc);
                    const copiedPages = await mergedPdfDoc.copyPages(doc, doc.getPageIndices());
                    copiedPages.forEach(p => mergedPdfDoc.addPage(p));
                } catch (mergeErr) {
                    console.warn(`⚠️ Could not copy pages from file ${file.originalname}:`, mergeErr.message);
                }

                // Clean up temporary upload file
                try { fs.unlinkSync(file.path); } catch(e){}
            }

            const mergedBytes = await mergedPdfDoc.save();
            fs.writeFileSync(masterFilePath, mergedBytes);
        }

        const originalFileName = fileNames.join(', ');
        const emailSubject = `Please Sign document package (${fileNames.length} file${fileNames.length > 1 ? 's' : ''})`;

        // Build Recipient List
        const recipients = clients.map(c => ({ ...c, role: 'Client' }));
        if (includeSender) {
            recipients.push({ name: senderName, email: senderEmail, role: 'Sender' });
        }

        saveEnvelope(envelopeId, {
            status: 'in_progress',
            filePath: masterFilePath,
            originalName: originalFileName, 
            senderName: senderName,
            senderEmail: senderEmail,
            recipients: recipients,
            assignedFields: assignedFields,
            emailSubject: emailSubject,
            currentRecipientIndex: 0,
            history: [] 
        });

        if (recipients.length > 0) {
            await notifyNextSigner(envelopeId);
        } else {
            throw new Error("No recipients defined!");
        }

        res.json({ success: true, envelopeId });
    } catch (e) {
        console.error("SEND ERROR:", e);
        let errMsg = e.message;
        if (errMsg.includes("PDFDict") || errMsg.includes("encrypted")) {
            errMsg = "The uploaded PDF is DRM-encrypted or has corrupted internal PDF structures. Please re-export or 'Print to PDF' and try again.";
        }
        res.status(500).json({ error: errMsg });
    }
});

async function notifyNextSigner(id) {
    const env = getEnvelope(id);
    if (!env) return;

    const signer = env.recipients[env.currentRecipientIndex];
    
    // --- USE CONFIG URL ---
    const link = `${CONFIG.BASE_URL}/sign/${id}?idx=${env.currentRecipientIndex}`;
    
    console.log(`Sending email to ${signer.email} using URL: ${CONFIG.BASE_URL}`);

    await transporter.sendMail({
        from: `"E-Sign" <${CONFIG.EMAIL_USER}>`,
        to: signer.email,
        subject: env.emailSubject, 
        html: `
            <h3>Hello ${signer.name},</h3>
            <p>Please review and sign the attached document: <b>${env.originalName || 'Document'}</b></p>
            <a href="${link}" style="background:#007bff;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Review & Sign</a>
            <br><br>
            <small>Link: ${link}</small>
        `
    });
}

// ======================================================
// 2. VIEW: SERVE PAGES
// ======================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/sign/:id', (req, res) => res.sendFile(path.join(__dirname, 'signer.html')));

app.get('/api/envelope-info/:id', (req, res) => {
    const env = getEnvelope(req.params.id);
    if (!env) return res.status(404).json({ error: "Not found" });
    
    const idx = parseInt(req.query.idx) || 0;
    if (idx !== env.currentRecipientIndex && env.status !== 'completed') {
        return res.json({ error: "It is not your turn yet." });
    }
    const signer = env.recipients[idx];
    
    // Filter fields pre-assigned to this recipient
    const myFields = (env.assignedFields || []).filter(f => f.recipientIndex === idx);

    res.json({ 
        signerName: signer.name, 
        role: signer.role,
        assignedFields: myFields,
        totalRecipients: env.recipients.length,
        currentRecipientIndex: idx
    });
});

app.get('/api/envelope/:id', (req, res) => {
    const env = getEnvelope(req.params.id);
    if (env && fs.existsSync(env.filePath)) res.sendFile(path.resolve(env.filePath));
    else res.status(404).send("File not found");
});

// ======================================================
// 3. ACTION: SIGN & BURN FEATURES
// ======================================================
app.post('/api/sign/:id', upload.none(), async (req, res) => {
    try {
        const id = req.params.id;
        const env = getEnvelope(id);
        const fields = JSON.parse(req.body.fields);
        const idx = parseInt(req.body.signerIndex);
        const signerInfo = env.recipients[idx];

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

        // 1. Load PDF
        const pdfBytes = fs.readFileSync(env.filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        repairPdfPageTree(pdfDoc);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const pages = pdfDoc.getPages();

        // 2. Burn Annotations
        for (const field of fields) {
            if (field.pageIndex >= pages.length) continue;
            const page = pages[field.pageIndex];
            const { width: pageWidth, height: pageHeight } = page.getSize();
            
            // Calculate exact position based on relative percentage
            const x = pageWidth * (field.xPercent !== undefined ? parseFloat(field.xPercent) : (parseFloat(field.x) / pageWidth));
            const yPercent = field.yPercent !== undefined ? parseFloat(field.yPercent) : (parseFloat(field.y) / pageHeight);
            const y = pageHeight - (pageHeight * yPercent);

            if (field.type === 'signature' || field.type === 'initial' || field.type === 'image') {
                const img = await pdfDoc.embedPng(field.value);
                
                // Maintain image aspect ratio
                const sigWidth = field.wPercent ? Math.max(pageWidth * parseFloat(field.wPercent), 80) : 120;
                const sigHeight = (img.height / img.width) * sigWidth;
                const blockHeight = sigHeight + 12;
                const drawY = y - blockHeight;

                // 1. "eSigned by:" label
                page.drawText('eSigned by:', {
                    x: x + 5,
                    y: drawY + sigHeight + 4,
                    size: 9,
                    font: fontBold,
                    color: rgb(0.2, 0.2, 0.2)
                });

                // 2. Signature image
                page.drawImage(img, {
                    x: x + 10,
                    y: drawY + 6,
                    width: sigWidth,
                    height: sigHeight
                });

                // 3. Verification ID Code
                const uuid = Math.random().toString(36).substring(2, 10).toUpperCase();
                page.drawText(`ID: ${uuid}`, {
                    x: x + 5,
                    y: drawY - 2,
                    size: 7,
                    font: font,
                    color: rgb(0.4, 0.4, 0.4)
                });

                // 4. Blue Side Bracket
                const bracketColor = rgb(0, 0.35, 0.65);
                page.drawLine({ start: { x: x, y: drawY - 2 }, end: { x: x, y: drawY + blockHeight }, thickness: 2, color: bracketColor });
                page.drawLine({ start: { x: x, y: drawY + blockHeight }, end: { x: x + 8, y: drawY + blockHeight }, thickness: 2, color: bracketColor });
                page.drawLine({ start: { x: x, y: drawY - 2 }, end: { x: x + 8, y: drawY - 2 }, thickness: 2, color: bracketColor });

            } else {
                // Text or Date field: baseline sits 14 points below top
                const drawY = y - 14;
                const textVal = String(field.value || '');
                try {
                    page.drawText(textVal, {
                        x: x,
                        y: drawY,
                        size: 12,
                        font: font,
                        color: rgb(0, 0, 0)
                    });
                } catch (fontErr) {
                    console.warn("⚠️ Non-WinAnsi characters detected, sanitizing for PDF embedding:", fontErr.message);
                    const sanitized = textVal.replace(/[^\x00-\x7F]/g, '?');
                    page.drawText(sanitized, {
                        x: x,
                        y: drawY,
                        size: 12,
                        font: font,
                        color: rgb(0, 0, 0)
                    });
                }
            }
        }

        // 3. Save PDF
        const updatedPdfBytes = await pdfDoc.save();
        fs.writeFileSync(env.filePath, updatedPdfBytes);

        // 4. Update Audit History
        env.history.push({
            name: signerInfo.name,
            email: signerInfo.email,
            action: "Signed",
            ip: ip,
            date: new Date().toISOString()
        });

        env.currentRecipientIndex++;

        // 5. Check Completion
        if (env.currentRecipientIndex >= env.recipients.length) {
            env.status = 'completed';
            await finalizeEnvelope(id, env);
            res.json({ success: true, completed: true });
        } else {
            saveEnvelope(id, env);
            await notifyNextSigner(id);
            res.json({ success: true, completed: false });
        }

    } catch (e) {
        console.error("SIGN ERROR:", e);
        res.status(500).json({ error: e.message });
    }
});

// Helper: Finalize with Audit Page & Certificate
async function finalizeEnvelope(id, env) {
    try {
        const pdfBytes = fs.readFileSync(env.filePath);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        repairPdfPageTree(pdfDoc);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        
        page.drawText('Certificate of Completion', { x: 50, y: height - 50, size: 24, font: fontBold });
        page.drawText(`Envelope ID: ${id}`, { x: 50, y: height - 80, size: 10, font, color: rgb(0.5,0.5,0.5) });
        
        let yPos = height - 120;
        
        page.drawText('Signer Events', { x: 50, y: yPos, size: 12, font: fontBold });
        page.drawText('Status', { x: 250, y: yPos, size: 12, font: fontBold });
        page.drawText('Timestamp / IP', { x: 350, y: yPos, size: 12, font: fontBold });
        yPos -= 20;
        page.drawLine({ start: { x: 50, y: yPos }, end: { x: 550, y: yPos }, thickness: 1 });
        yPos -= 20;

        for (const h of env.history) {
            page.drawText(`${h.name} (${h.email})`, { x: 50, y: yPos, size: 10, font });
            page.drawText('eSigned', { x: 250, y: yPos, size: 10, font, color: rgb(0, 0.5, 0) });
            page.drawText(`${h.date.split('T')[0]} ${h.date.split('T')[1].substr(0,8)}`, { x: 350, y: yPos, size: 9, font });
            page.drawText(`IP: ${h.ip}`, { x: 350, y: yPos - 12, size: 8, font, color: rgb(0.4,0.4,0.4) });
            yPos -= 40; 
        }

        const pdfWithAudit = await pdfDoc.save({ useObjectStreams: false });
        const pdfBuffer = Buffer.from(pdfWithAudit);

        const p12Signature = new P12Signer(p12Buffer, { passphrase: 'password' });
        const placeholderResult = plainAddPlaceholder({
            pdfBuffer: pdfBuffer,
            reason: 'Certified by E-Sign App',
            signatureLength: 16000 
        });
        const signedPdf = await new SignPdf().sign(placeholderResult, p12Signature);

        // Send final completed signed document PDF & Certificate to ALL recipients AND the Sender
        const finalEmails = new Set(env.recipients.map(r => r.email));
        if (env.senderEmail) {
            finalEmails.add(env.senderEmail);
        }

        for (const recipientEmail of finalEmails) {
            await transporter.sendMail({
                from: `"E-Sign" <${CONFIG.EMAIL_USER}>`,
                to: recipientEmail,
                subject: `Completed: ${env.emailSubject}`,
                text: `Hello,\n\nThe document package "${env.originalName}" has been fully signed by all parties. Attached is the final completed PDF with the Certificate of Completion.\n\nThank you!`,
                attachments: [{ filename: `Completed_${env.originalName || 'document'}.pdf`, content: signedPdf }]
            });
        }
        
        deleteEnvelope(id);
        if(fs.existsSync(env.filePath)) fs.unlinkSync(env.filePath);

    } catch (e) {
        console.error("FINALIZE ERROR:", e);
        throw e;
    }
}

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));