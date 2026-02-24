'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Hardcode the target - change this when switching between local and HF
// const API_BASE = 'https://punya-mittal-uni.hf.space'; // Uncomment for HF testing
const API_BASE = 'http://localhost:8080';

/**
 * Fetches an auth token via HTTP before the WebSocket connect step.
 * Used as a flow function step: `- function: "getToken"`
 * Fails the scenario if token cannot be obtained (prevents 400/401 WebSocket errors).
 */
function getToken(context, ee, done) {
    const url = `${API_BASE}/api/auth/token`;
    const username = context.vars.username || 'anonymous';

    const client = url.startsWith('https') ? https : http;
    const parsedUrl = new URL(url);

    const req = client.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
            if (res.statusCode !== 200) {
                return done(new Error(`Auth failed: HTTP ${res.statusCode} - ${body.substring(0, 200)}`));
            }
            try {
                const data = JSON.parse(body);
                if (data.token && typeof data.token === 'string') {
                    context.vars.token = data.token;
                    // URL-encoded version for query string (avoids issues with special chars)
                    context.vars.tokenEncoded = encodeURIComponent(data.token);
                } else {
                    return done(new Error(`No token in response: ${body.substring(0, 100)}`));
                }
            } catch (e) {
                return done(new Error(`Parse error: ${e.message}, body: ${body.substring(0, 100)}`));
            }
            return done();
        });
    });

    req.on('error', (err) => {
        return done(err);
    });

    req.setTimeout(10000, () => {
        req.destroy();
        done(new Error('Token request timeout'));
    });

    req.end();
}

/**
 * Connect handler - builds WebSocket URL with token. Use when connect object format
 * doesn't support per-VU template variables in headers.
 */
function connectWithToken(params, context, next) {
    const base = (params.target || context.vars.target || 'ws://localhost:8080').replace(/\/$/, '');
    const token = context.vars.token;
    if (!token) {
        return next(new Error('No token - getToken may have failed'));
    }
    params.target = `${base}/ws?token=${encodeURIComponent(token)}`;
    next();
}

module.exports = {
    getToken,
    connectWithToken
};
