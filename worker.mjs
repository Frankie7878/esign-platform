import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

const app = new Hono();

// Serve Static Assets (index.html, signer.html, dashboard.html, js/...)
app.use('/*', serveStatic({ root: './' }));

const GITHUB_CLIENT_ID = 'Ov23liTMskA0wVZzq2ee';
const GITHUB_CLIENT_SECRET = '03bc8d55baa1b578e1ccc95787494b25e76c997d';

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

// Serve Dashboard & Front-End Pages
app.get('/', (c) => c.redirect('/index.html'));
app.get('/dashboard', (c) => c.redirect('/dashboard.html'));

// Health Check API
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'E-Sign Platform Worker', timestamp: new Date().toISOString() }));

export default app;
