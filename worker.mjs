import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

const app = new Hono();

// Serve Dashboard & Front-End Pages
app.get('/dashboard', (c) => c.redirect('/dashboard.html'));

// Health Check API
app.get('/api/health', (c) => c.json({ status: 'ok', service: 'E-Sign Platform Worker', timestamp: new Date().toISOString() }));

// Root Handler
app.get('/', (c) => c.json({ message: '🚀 E-Sign Platform Cloudflare Worker API Ready' }));

export default app;
