import { Hono } from 'hono';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const app = new Hono();

const GITHUB_CLIENT_ID = 'Ov23liTMskA0wVZzq2ee';
const GITHUB_CLIENT_SECRET = '03bc8d55baa1b578e1ccc95787494b25e76c997d';

// In-Memory Global Envelope Store for Cloudflare Worker
const ENVELOPES = {};

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

// Root Redirect to /index.html & /dashboard.html
app.get('/', (c) => c.redirect('/index.html'));
app.get('/dashboard', (c) => c.redirect('/dashboard.html'));

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
        
        // Merge PDFs in memory using pdf-lib
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

        return c.json({ success: true, envelopeId });
    } catch(e) {
        console.error("Worker SEND ERROR:", e);
        return c.json({ error: e.message }, 500);
    }
});

// API: Fetch All Envelopes for Dashboard
app.get('/api/envelopes', (c) => {
    return c.json(Object.values(ENVELOPES));
});

// API: Fetch Single Envelope Info / PDF
app.get('/api/envelope/:id', (c) => {
    const id = c.req.param('id');
    const env = ENVELOPES[id];
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

// API: Submit Recipient Signature
app.post('/api/sign', async (c) => {
    try {
        const body = await c.req.json();
        const { envelopeId, fields } = body;
        const env = ENVELOPES[envelopeId];
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
