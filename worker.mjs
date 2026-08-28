import { Hono } from 'hono';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { P12Signer } from '@signpdf/signer-p12';
import forge from 'node-forge';

const app = new Hono();

const GITHUB_CLIENT_ID = 'Ov23liTMskA0wVZzq2ee';
const GITHUB_CLIENT_SECRET = '03bc8d55baa1b578e1ccc95787494b25e76c997d';

// Global In-Memory Fallback
const ENVELOPES = {};

// Helper: Get Actalis P12 Certificate Buffer from Cloudflare KV
async function getWorkerP12Buffer(c) {
    if (c.env && c.env.ESIGN_KV) {
        try {
            const p12ArrayBuf = await c.env.ESIGN_KV.get('ACTALIS_P12', 'arrayBuffer');
            if (p12ArrayBuf && p12ArrayBuf.byteLength > 0) {
                return Buffer.from(p12ArrayBuf);
            }
        } catch(e){}
    }
    // Fallback: Generate Self-Signed Cert
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
    const attrs = [
        { name: 'commonName', value: 'E-Sign Security Certification Authority' },
        { name: 'organizationName', value: 'E-Sign Platform Legal Trust Services' }
    ];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'password');
    return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

function getWorkerP12Password(c) {
    if (c.env && c.env.P12_PASSWORD) {
        return c.env.P12_PASSWORD;
    }
    return 'password';
}

// Helper: Send Transactional Email (Resend API or Mailchannels)
async function sendWorkerEmail(c, { toEmail, toName, subject, htmlContent, attachments = [] }) {
    if (c && c.env && c.env.RESEND_API_KEY) {
        try {
            const resendPayload = {
                from: "E-Sign Platform <noreply@frank-zhang.com>",
                to: [toEmail],
                subject: subject,
                html: htmlContent
            };
            if (attachments && attachments.length > 0) {
                resendPayload.attachments = attachments.map(a => ({
                    content: a.content.toString('base64'),
                    filename: a.filename
                }));
            }
            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${c.env.RESEND_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(resendPayload)
            });
            const resText = await res.text();
            console.log(`Resend Send Status (${res.status}):`, resText);
            if (res.ok) return true;
        } catch(e) {
            console.error("Resend send error:", e);
        }
    }

    try {
        const payload = {
            personalizations: [{ to: [{ email: toEmail, name: toName || toEmail }] }],
            from: { email: "noreply@frank-zhang.com", name: "E-Sign Platform" },
            subject: subject,
            content: [{ type: "text/html", value: htmlContent }]
        };

        if (attachments && attachments.length > 0) {
            payload.attachments = attachments.map(a => ({
                content: a.content.toString('base64'),
                type: 'application/pdf',
                filename: a.filename
            }));
        }

        const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "X-MC-Relay": "true"
            },
            body: JSON.stringify(payload)
        });
        const resText = await res.text();
        console.log(`Mailchannels Send Status (${res.status}):`, resText);
        return res.ok;
    } catch(err) {
        console.error("Mailchannels send error:", err);
        return false;
    }
}

// Health Check API
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'E-Sign Cloud Serverless Worker', timestamp: new Date().toISOString() }));

const PASSCODE_LOCK_HTML = `
    <!-- MASTER PASSCODE LOCK MODAL -->
    <div id="passcodeLockModal" style="display: flex;" class="fixed inset-0 bg-slate-900/95 backdrop-blur-md z-[9999] items-center justify-center p-4">
        <div class="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-md w-full p-8 text-center relative overflow-hidden">
            <div class="w-16 h-16 bg-blue-50 border border-blue-200 text-blue-600 rounded-2xl flex items-center justify-center mx-auto text-3xl mb-4 shadow-sm">
                🔒
            </div>
            <h2 class="text-2xl font-extrabold text-slate-900 mb-1">E-Sign Security Portal</h2>
            <p class="text-xs text-slate-500 mb-6">Enter master passcode to unlock system access</p>
            
            <form onsubmit="verifyPasscode(event)" class="space-y-4">
                <div>
                    <input type="password" id="passcodeInput" placeholder="Enter Passcode" autofocus class="w-full text-center text-2xl font-mono tracking-widest border border-slate-300 p-3.5 rounded-xl outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600 shadow-inner">
                </div>
                <p id="passcodeError" class="text-xs text-red-500 font-bold hidden">❌ Incorrect passcode. Try again.</p>
                <button type="submit" class="w-full py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-md transition cursor-pointer text-sm">
                    Unlock System 🔓
                </button>
            </form>
        </div>
    </div>
    <script>
        (function() {
            const saved = localStorage.getItem('esign_passcode');
            const modal = document.getElementById('passcodeLockModal');
            if (saved === '800618' && modal) {
                modal.style.display = 'none';
            }
        })();
    </script>
`;

async function serveHtmlWithPasscodeLock(c, assetPath) {
    if (c.env && c.env.ASSETS) {
        const req = new Request(new URL(assetPath, c.req.url), c.req.raw);
        const res = await c.env.ASSETS.fetch(req);
        let html = await res.text();
        if (!html.includes('passcodeLockModal')) {
            html = html.replace('<body', `${PASSCODE_LOCK_HTML}\n<body`);
        }
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(html, { status: 200, headers });
    }
    return c.notFound();
}

// Serve Fresh Uncached HTML Pages with Passcode Lock
app.get('/', (c) => serveHtmlWithPasscodeLock(c, '/index.html'));
app.get('/index.html', (c) => serveHtmlWithPasscodeLock(c, '/index.html'));
app.get('/dashboard', (c) => serveHtmlWithPasscodeLock(c, '/dashboard.html'));
app.get('/dashboard.html', (c) => serveHtmlWithPasscodeLock(c, '/dashboard.html'));
app.get('/signer.html', (c) => serveHtmlWithPasscodeLock(c, '/signer.html'));
app.get('/sign/:id', (c) => serveHtmlWithPasscodeLock(c, '/signer.html'));

// API: Fetch Signer Info & Assigned Fields
app.get('/api/envelope-info/:id', async (c) => {
    const id = c.req.param('id');
    let env = ENVELOPES[id];
    if (!env && c.env && c.env.ESIGN_KV) {
        try {
            const itemStr = await c.env.ESIGN_KV.get(`env_${id}`);
            if (itemStr) env = JSON.parse(itemStr);
        } catch(e){}
    }

    if (!env) return c.json({ error: "Document package not found or link has expired." }, 404);

    if (env.status === 'voided' || env.status === 'cancelled') {
        return c.json({
            error: "voided",
            message: "This document package has been cancelled or voided by the sender."
        });
    }

    const idxStr = c.req.query('idx');
    const idx = idxStr ? parseInt(idxStr) : 0;

    if (idx < env.currentRecipientIndex) {
        return c.json({
            error: "already_signed",
            signerName: env.recipients[idx] ? env.recipients[idx].name : "Signer",
            message: "You have already completed signing this document."
        });
    }

    if (idx > env.currentRecipientIndex && env.status !== 'completed') {
        const currentSigner = env.recipients[env.currentRecipientIndex];
        return c.json({
            error: "not_your_turn",
            currentSignerName: currentSigner ? currentSigner.name : "previous signer",
            message: `It is not your turn yet. Currently waiting for ${currentSigner ? currentSigner.name : 'previous signer'} to finish.`
        });
    }

    const signer = env.recipients[idx];
    const assignedFields = (env.assignedFields || []).filter(f => 
        f.recipientIndex === idx || 
        f.signerIndex === idx || 
        (signer && f.signerEmail === signer.email) ||
        (f.recipientIndex === undefined && f.signerIndex === undefined)
    );

    return c.json({
        id: env.id,
        signerName: signer ? signer.name : "Signer",
        signerEmail: signer ? signer.email : "",
        assignedFields: assignedFields,
        status: env.status
    });
});

// API: Send Envelope (Upload PDFs & Create Chain)
app.post('/api/send', async (c) => {
    try {
        const body = await c.req.parseBody({ all: true });
        const pdfFiles = Array.isArray(body['pdf']) ? body['pdf'] : (body['pdf'] ? [body['pdf']] : []);
        if (pdfFiles.length === 0) return c.json({ error: "No PDF documents uploaded" }, 400);

        const clients = JSON.parse(body.clients || '[]');
        const senderName = body.senderName;
        const senderEmail = body.senderEmail;
        const includeSender = body.includeSender === 'true' || body.includeSender === true;
        const assignedFields = JSON.parse(body.assignedFields || '[]');

        const envelopeId = Math.random().toString(36).substring(2, 10).toUpperCase();
        
        const mergedDoc = await PDFDocument.create();
        const fileNames = [];
        for (const file of pdfFiles) {
            fileNames.push(file.name || 'document.pdf');
            const bytes = await file.arrayBuffer();
            const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
            const pages = await mergedDoc.copyPages(doc, doc.getPageIndices());
            pages.forEach(p => mergedDoc.addPage(p));
        }
        const mergedBytes = await mergedDoc.save({ useObjectStreams: false });

        const recipients = clients.map(cl => ({ ...cl, role: 'Client' }));
        if (includeSender) {
            recipients.push({ name: senderName, email: senderEmail, role: 'Sender' });
        }

        const envObj = {
            id: envelopeId,
            status: 'in_progress',
            createdAt: new Date().toISOString(),
            originalName: fileNames.join(', '),
            senderName,
            senderEmail,
            recipients,
            assignedFields,
            emailSubject: `Please Sign document package (${fileNames.length} file${fileNames.length > 1 ? 's' : ''})`,
            currentRecipientIndex: 0,
            history: [],
            pdfBase64: Buffer.from(mergedBytes).toString('base64')
        };

        ENVELOPES[envelopeId] = envObj;
        if (c.env && c.env.ESIGN_KV) {
            try { await c.env.ESIGN_KV.put(`env_${envelopeId}`, JSON.stringify(envObj)); } catch(e){}
        }

        if (recipients.length > 0) {
            const firstSigner = recipients[0];
            const signUrl = `https://docusign.frank-zhang.com/signer.html?id=${envelopeId}`;
            await sendWorkerEmail(c, {
                toEmail: firstSigner.email,
                toName: firstSigner.name,
                subject: `Please Sign: ${envObj.originalName}`,
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 550px; margin: 0 auto; background-color: #ffffff;">
                        <h2 style="color: #0f172a; margin-top: 0; font-size: 20px;">✍️ Signature Request</h2>
                        <p style="color: #334155; font-size: 14px;">Hello <b>${firstSigner.name}</b>,</p>
                        <p style="color: #334155; font-size: 14px;"><b>${senderName}</b> has sent you a document package (<b>${envObj.originalName}</b>) for your electronic signature.</p>
                        <div style="margin: 28px 0; text-align: center;">
                            <a href="${signUrl}" style="background-color: #2563eb; color: #ffffff; padding: 14px 30px; font-weight: bold; border-radius: 8px; text-decoration: none; display: inline-block; font-size: 15px;">Review & Sign Document</a>
                        </div>
                    </div>
                `
            });
        }

        return c.json({ success: true, envelopeId });
    } catch(e) {
        console.error("Worker SEND ERROR:", e);
        return c.json({ error: e.message }, 500);
    }
});

// API: Fetch All Envelopes for Dashboard
app.get('/api/envelopes', async (c) => {
    if (c.env && c.env.ESIGN_KV) {
        try {
            const list = await c.env.ESIGN_KV.list({ prefix: 'env_' });
            const envs = [];
            for (const key of list.keys) {
                const itemStr = await c.env.ESIGN_KV.get(key.name);
                if (itemStr) envs.push(JSON.parse(itemStr));
            }
            if (envs.length > 0) return c.json(envs);
        } catch(e){}
    }
    return c.json(Object.values(ENVELOPES));
});

// API: Fetch Single Envelope Info / PDF
app.get('/api/envelope/:id', async (c) => {
    const id = c.req.param('id');
    let env = ENVELOPES[id];
    if (!env && c.env && c.env.ESIGN_KV) {
        try {
            const itemStr = await c.env.ESIGN_KV.get(`env_${id}`);
            if (itemStr) env = JSON.parse(itemStr);
        } catch(e){}
    }

    if (!env) return c.json({ error: "Envelope not found" }, 404);

    const accept = c.req.header('Accept') || '';
    if (accept.includes('application/json')) {
        return c.json(env);
    }

    const pdfBuf = Buffer.from(env.pdfBase64, 'base64');
    return new Response(pdfBuf, {
        headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="Envelope_${id}.pdf"`
        }
    });
});

// API: Download Completed PDF Document Package
app.get('/api/download/:id', async (c) => {
    const id = c.req.param('id');
    let env = ENVELOPES[id];
    if (!env && c.env && c.env.ESIGN_KV) {
        try {
            const itemStr = await c.env.ESIGN_KV.get(`env_${id}`);
            if (itemStr) env = JSON.parse(itemStr);
        } catch(e){}
    }

    if (!env || !env.pdfBase64) return c.text("PDF file not found", 404);

    const pdfBuf = Buffer.from(env.pdfBase64, 'base64');
    return new Response(pdfBuf, {
        headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="Completed_${env.originalName || 'document'}.pdf"`
        }
    });
});

// API: Resend Notification Email to Current Signer
app.post('/api/resend/:id', async (c) => {
    try {
        const id = c.req.param('id');
        let env = ENVELOPES[id];
        if (!env && c.env && c.env.ESIGN_KV) {
            try {
                const itemStr = await c.env.ESIGN_KV.get(`env_${id}`);
                if (itemStr) env = JSON.parse(itemStr);
            } catch(e){}
        }

        if (!env) return c.json({ error: "Envelope not found" }, 404);

        const currentSigner = env.recipients[env.currentRecipientIndex];
        if (!currentSigner) return c.json({ error: "No active recipient to resend email to" }, 400);

        const signUrl = `https://docusign.frank-zhang.com/signer.html?id=${id}`;
        const emailSent = await sendWorkerEmail(c, {
            toEmail: currentSigner.email,
            toName: currentSigner.name,
            subject: `Reminder: Please Sign ${env.originalName}`,
            htmlContent: `
                <div style="font-family: Arial, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 550px; margin: 0 auto; background-color: #ffffff;">
                    <h2 style="color: #0f172a; margin-top: 0; font-size: 20px;">🔔 Signature Reminder</h2>
                    <p style="color: #334155; font-size: 14px;">Hello <b>${currentSigner.name}</b>,</p>
                    <p style="color: #334155; font-size: 14px;">This is a friendly reminder to review and sign the document package (<b>${env.originalName}</b>).</p>
                    <div style="margin: 28px 0; text-align: center;">
                        <a href="${signUrl}" style="background-color: #2563eb; color: #ffffff; padding: 14px 30px; font-weight: bold; border-radius: 8px; text-decoration: none; display: inline-block; font-size: 15px;">Review & Sign Document</a>
                    </div>
                </div>
            `
        });

        return c.json({ success: true, message: `Reminder email resent to ${currentSigner.email}`, sentTo: currentSigner.email, emailSent });
    } catch(e) {
        console.error("Worker RESEND ERROR:", e);
        return c.json({ error: e.message }, 500);
    }
});

// API: Cancel / Delete Envelope
app.post('/api/cancel/:id', async (c) => {
    try {
        const id = c.req.param('id');
        delete ENVELOPES[id];
        if (c.env && c.env.ESIGN_KV) {
            try { await c.env.ESIGN_KV.delete(`env_${id}`); } catch(e){}
        }
        return c.json({ success: true });
    } catch(e) {
        console.error("Worker CANCEL ERROR:", e);
        return c.json({ error: e.message }, 500);
    }
});

// API: Submit Recipient Signature
app.post('/api/sign/:id', async (c) => {
    try {
        const body = await c.req.json();
        const { envelopeId, fields } = body;
        let env = ENVELOPES[envelopeId];
        if (!env && c.env && c.env.ESIGN_KV) {
            try {
                const itemStr = await c.env.ESIGN_KV.get(`env_${envelopeId}`);
                if (itemStr) env = JSON.parse(itemStr);
            } catch(e){}
        }

        if (!env) return c.json({ error: "Envelope not found" }, 404);

        const pdfBuf = Buffer.from(env.pdfBase64, 'base64');
        const pdfDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });

        for (const f of fields || []) {
            const page = pdfDoc.getPage(f.pageIndex);
            if (!page) continue;
            const { width, height } = page.getSize();
            const x = width * f.xPercent;
            const y = height - (height * f.yPercent) - (height * f.hPercent);
            const w = width * f.wPercent;
            const h = height * f.hPercent;

            if (f.value && f.value.startsWith('data:image/')) {
                const imgBytes = Buffer.from(f.value.split(',')[1], 'base64');
                const img = f.value.includes('png') ? await pdfDoc.embedPng(imgBytes) : await pdfDoc.embedJpg(imgBytes);
                page.drawImage(img, { x, y, width: w, height: h });
            } else if (f.value) {
                const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
                page.drawText(String(f.value), { x, y: y + 5, size: 10, font });
            }
        }

        const currentSigner = env.recipients[env.currentRecipientIndex];
        if (currentSigner) {
            env.history.push({
                name: currentSigner.name,
                email: currentSigner.email,
                date: new Date().toISOString(),
                ip: c.req.header('cf-connecting-ip') || 'Cloudflare-Worker'
            });
        }

        env.currentRecipientIndex += 1;
        if (env.currentRecipientIndex >= env.recipients.length) {
            env.status = 'completed';
        }

        if (env.status === 'completed') {
            // Append Audit Trail Certificate of Completion Page
            const certPage = pdfDoc.addPage([612, 792]);
            const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            
            certPage.drawText('Certificate of Completion', { x: 50, y: 740, size: 20, font: fontBold });
            certPage.drawText(`Envelope ID: ${env.id}`, { x: 50, y: 715, size: 10, font });
            certPage.drawText(`Document: ${env.originalName}`, { x: 50, y: 700, size: 10, font });
            certPage.drawText(`Completed On: ${new Date().toISOString()}`, { x: 50, y: 685, size: 10, font });
            certPage.drawLine({ start: { x: 50, y: 670 }, end: { x: 550, y: 670 }, thickness: 1 });
            
            let yPos = 640;
            certPage.drawText('Signer Name & Email', { x: 50, y: yPos, size: 12, font: fontBold });
            certPage.drawText('Status', { x: 250, y: yPos, size: 12, font: fontBold });
            certPage.drawText('Timestamp / IP', { x: 350, y: yPos, size: 12, font: fontBold });
            yPos -= 20;
            certPage.drawLine({ start: { x: 50, y: yPos }, end: { x: 550, y: yPos }, thickness: 1 });
            yPos -= 20;

            for (const h of env.history) {
                certPage.drawText(`${h.name} (${h.email})`, { x: 50, y: yPos, size: 10, font });
                certPage.drawText('eSigned', { x: 250, y: yPos, size: 10, font, color: rgb(0, 0.5, 0) });
                certPage.drawText(`${h.date.split('T')[0]} ${h.date.split('T')[1].substr(0,8)}`, { x: 350, y: yPos, size: 9, font });
                certPage.drawText(`IP: ${h.ip}`, { x: 350, y: yPos - 12, size: 8, font, color: rgb(0.4,0.4,0.4) });
                yPos -= 40; 
            }

            const pdfWithAudit = await pdfDoc.save({ useObjectStreams: false });
            const pdfBuffer = Buffer.from(pdfWithAudit);

            const p12Buffer = await getWorkerP12Buffer(c);
            const p12Passphrase = getWorkerP12Password(c);
            const p12Signature = new P12Signer(p12Buffer, { passphrase: p12Passphrase });
            const placeholderResult = plainAddPlaceholder({
                pdfBuffer: pdfBuffer,
                name: 'Actalis Certified E-Sign Platform Authority',
                reason: 'Certified by E-Sign Platform Legal Trust Services',
                location: 'Toronto, ON, Canada',
                signingTime: new Date(),
                signatureLength: 16000 
            });
            const signedPdfBytes = await new SignPdf().sign(placeholderResult, p12Signature);
            const signedPdfBuf = Buffer.from(signedPdfBytes);
            env.pdfBase64 = signedPdfBuf.toString('base64');

            // Send Final Completed Document Email with Attachment via Mailchannels
            const finalEmails = new Set(env.recipients.map(r => r.email));
            if (env.senderEmail) finalEmails.add(env.senderEmail);

            for (const recipientEmail of finalEmails) {
                await sendWorkerEmail(c, {
                    toEmail: recipientEmail,
                    subject: `Completed: ${env.emailSubject}`,
                    htmlContent: `
                        <div style="font-family: Arial, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 550px; margin: 0 auto; background-color: #ffffff;">
                            <h2 style="color: #0f172a; margin-top: 0; font-size: 20px;">✅ Document Completed & Signed</h2>
                            <p style="color: #334155; font-size: 14px;">Hello,</p>
                            <p style="color: #334155; font-size: 14px;">The document package (<b>${env.originalName}</b>) has been fully signed by all parties. Attached is the final completed PDF with Actalis digital certification and Audit Trail Certificate.</p>
                        </div>
                    `,
                    attachments: [{ filename: `Completed_${env.originalName || 'document'}.pdf`, content: signedPdfBuf }]
                });
            }
        } else {
            // Notify Next Signer
            const nextSigner = env.recipients[env.currentRecipientIndex];
            if (nextSigner) {
                const signUrl = `https://docusign.frank-zhang.com/signer.html?id=${envelopeId}`;
                await sendWorkerEmail(c, {
                    toEmail: nextSigner.email,
                    toName: nextSigner.name,
                    subject: `Please Sign: ${env.originalName}`,
                    htmlContent: `
                        <div style="font-family: Arial, sans-serif; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 550px; margin: 0 auto; background-color: #ffffff;">
                            <h2 style="color: #0f172a; margin-top: 0; font-size: 20px;">✍️ Signature Request</h2>
                            <p style="color: #334155; font-size: 14px;">Hello <b>${nextSigner.name}</b>,</p>
                            <p style="color: #334155; font-size: 14px;">It is your turn to review and electronically sign the document package (<b>${env.originalName}</b>).</p>
                            <div style="margin: 28px 0; text-align: center;">
                                <a href="${signUrl}" style="background-color: #2563eb; color: #ffffff; padding: 14px 30px; font-weight: bold; border-radius: 8px; text-decoration: none; display: inline-block; font-size: 15px;">Review & Sign Document</a>
                            </div>
                        </div>
                    `
                });
            }
        }

        ENVELOPES[envelopeId] = env;
        if (c.env && c.env.ESIGN_KV) {
            try { await c.env.ESIGN_KV.put(`env_${envelopeId}`, JSON.stringify(env)); } catch(e){}
        }

        return c.json({ success: true, completed: env.status === 'completed' });
    } catch(e) {
        console.error("Worker SIGN ERROR:", e);
        return c.json({ error: e.message }, 500);
    }
});

// Fallback: Serve Static Assets (index.html, signer.html, dashboard.html, js/...) from Cloudflare ASSETS binding
app.get('*', async (c) => {
    if (c.env && c.env.ASSETS) {
        return c.env.ASSETS.fetch(c.req.raw);
    }
    return c.text('Asset Not Found', 404);
});

export default app;
