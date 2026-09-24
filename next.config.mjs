/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
};
export default nextConfig;
