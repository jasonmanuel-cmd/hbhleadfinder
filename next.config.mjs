/** @type {import('next').NextConfig} */
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

const nextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
      // Next rejects a server action whose Origin header does not match the host it
      // sees. Behind a proxy that rewrites the host, the login form dies with
      // "Invalid Server Actions request". This allowlist (wildcards allowed) says
      // which origins are acceptable. Development only by default -- in production
      // the origin has to match, so set it deliberately if you need it.
      ...(process.env.SERVER_ACTIONS_ALLOWED_ORIGINS
        ? { allowedOrigins: list(process.env.SERVER_ACTIONS_ALLOWED_ORIGINS) }
        : {}),
    },
  },
  // In development, Next blocks requests for its own dev resources (the HMR socket,
  // self-hosted fonts) when they come from a host it does not recognise. Running the
  // dev server behind a preview proxy makes every host unrecognised, which breaks hot
  // reload and the font. `*.e2b.app` covers the hosted preview; override with
  // DEV_ALLOWED_ORIGINS (comma separated) for anything else. Ignored in production.
  allowedDevOrigins: list(process.env.DEV_ALLOWED_ORIGINS || '*.e2b.app'),
};
export default nextConfig;
