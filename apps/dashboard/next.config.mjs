/** @type {import('next').NextConfig} */
const nextConfig = {
    /* config options here */
    output: "standalone",
    reactStrictMode: true,
    poweredByHeader: false,
    webpack: (config) => {
        config.externals.push({
            "utf-8-validate": "commonjs utf-8-validate",
            "bufferutil": "commonjs bufferutil",
        });
        return config;
    },
};

export default nextConfig;
