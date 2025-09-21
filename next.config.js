/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Allow builds to proceed without installing ESLint locally.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
