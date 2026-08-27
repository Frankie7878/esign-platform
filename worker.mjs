import { Hono } from 'hono';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const app = new Hono();

const GITHUB_CLIENT_ID = 'Ov23liTMskA0wVZzq2ee';
const GITHUB_CLIENT_SECRET = '03bc8d55baa1b578e1ccc95787494b25e76c997d';
const BACKEND_URL = 'https://broadly-cuticolor-lavelle.ngrok-free.dev';

// Global Memory Store Fallback
const ENVELOPES = {};

// Helper: Proxy API Requests to Live Active Node Engine (Gmail Nodemailer & database.json)
async function proxyToBackend(c) {
    const url = new URL(c.req.url);
    const targetUrl = `${BACKEND_URL}${url.pathname}${url.search}`;
    
    try {
        const reqHeaders = new Headers(c.req.raw.headers);
        reqHeaders.set('host', 'broadly-cuticolor-lavelle.ngrok-free.dev');
        reqHeaders.set('ngrok-skip-browser-warning', 'true');

        const fetchOpts = {
            method: c.req.method,
            headers: reqHeaders
        };

        if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
            fetchOpts.body = c.req.raw.body;
            fetchOpts.duplex = 'half';
        }

        const res = await fetch(targetUrl, fetchOpts);
        if (res.ok || res.status < 500) {
            return res;
        }
    } catch(err) {
        console.warn("Backend proxy failed, using Worker local fallback:", err.message);
    }
    return null;
}

// Helper: Send Transactional Email via Mailchannels (Free for Cloudflare Workers)
async function sendWorkerEmail({ toEmail, toName, subject, htmlContent }) {
    try {
        const payload = {
            personalizations: [{ to: [{ email: toEmail, name: toName || toEmail }] }],
            from: { email: "noreply@docusign.frank-zhang.com", name: "E-Sign Platform" },
            subject: subject,
            content: [{ type: "text/html", value: htmlContent }]
        };
        const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log(`Mailchannels email status for ${toEmail}:`, res.status);
        return res.ok;
    } catch(e) {
        console.error("Mailchannels Email Error:", e);
        return false;
    }
}

// GitHub OAuth Authorization
app.get('/api/auth/github', (c) => {
    const redirectUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=user:email`;
    return c.redirect(redirectUrl);
});

// GitHub OAuth Callback
app.get('/api/auth/github/callback', async (c) => {
    const code = c.req.query('code');
    if (!code) return c.text('Missing code parameter', 400);

    try {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'E-Sign-Platform'
            },
            body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                client_secret: GITHUB_CLIENT_SECRET,
                code: code
            })
        });
        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;
        if (!accessToken) throw new Error(tokenData.error_description || 'Failed to get access token');

        const userRes = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'E-Sign-Platform'
            }
        });
        const userData = await userRes.json();

        let email = userData.email;
        if (!email) {
            const emailRes = await fetch('https://api.github.com/user/emails', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': 'E-Sign-Platform'
                }
            });
            const emails = await emailRes.json();
            const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) || emails[0] : null;
            if (primary) email = primary.email;
        }

        const userPayload = {
            id: userData.id,
            login: userData.login,
            name: userData.name || userData.login,
            email: email || `${userData.login}@users.noreply.github.com`,
            avatar_url: userData.avatar_url,
            provider: 'github'
        };

        const encodedUser = encodeURIComponent(JSON.stringify(userPayload));
        return c.redirect(`/dashboard.html?github_user=${encodedUser}`);

    } catch(err) {
        console.error("GitHub Auth Error:", err);
        return c.text("GitHub Auth Error: " + err.message, 500);
    }
});

// Health Check API
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'E-Sign Platform Worker', timestamp: new Date().toISOString() }));

// Serve Fresh Uncached HTML Pages
app.get('/', async (c) => {
    if (c.env && c.env.ASSETS) {
        const req = new Request(new URL('/index.html', c.req.url), c.req.raw);
        const res = await c.env.ASSETS.fetch(req);
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return new Response(res.body, { status: res.status, headers });
    }
    return c.redirect('/index.html');
});

app.get('/index.html', async (c) => {
    if (c.env && c.env.ASSETS) {
        const req = new Request(new URL('/index.html', c.req.url), c.req.raw);
        const res = await c.env.ASSETS.fetch(req);
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return new Response(res.body, { status: res.status, headers });
    }
    return c.notFound();
});

app.get('/dashboard', async (c) => {
    if (c.env && c.env.ASSETS) {
        const req = new Request(new URL('/dashboard.html', c.req.url), c.req.raw);
        const res = await c.env.ASSETS.fetch(req);
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return new Response(res.body, { status: res.status, headers });
    }
    return c.redirect('/dashboard.html');
});

app.get('/dashboard.html', async (c) => {
    if (c.env && c.env.ASSETS) {
        const req = new Request(new URL('/dashboard.html', c.req.url), c.req.raw);
        const res = await c.env.ASSETS.fetch(req);
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return new Response(res.body, { status: res.status, headers });
    }
    return c.notFound();
});

// API: Send Envelope (Upload PDFs & Create Chain)
app.post('/api/send', async (c) => {
    const proxied = await proxyToBackend(c);
    if (proxied) return proxied;

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
            await sendWorkerEmail({
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
    const proxied = await proxyToBackend(c);
    if (proxied) return proxied;

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
    const proxied = await proxyToBackend(c);
    if (proxied) return proxied;

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
    const proxied = await proxyToBackend(c);
    if (proxied) return proxied;

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
    const proxied = await proxyToBackend(c);
    if (proxied) return proxied;

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
        const emailSent = await sendWorkerEmail({
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
    const proxied = await proxyToBackend(c);
    if (proxied) return proxied;

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
    const proxied = await proxyToBackend(c);
    if (proxied) return proxied;

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

        const updatedBytes = await pdfDoc.save({ useObjectStreams: false });
        env.pdfBase64 = Buffer.from(updatedBytes).toString('base64');

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
