import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'sing-box Internals',
  description: 'Complete technical analysis of sing-box for reimplementation',
  head: [['link', { rel: 'icon', href: '/favicon.ico' }]],
  themeConfig: {
    nav: [
      { text: 'Architecture', link: '/architecture/overview' },
      { text: 'Protocols', link: '/protocols/overview' },
      { text: 'Transport', link: '/transport/overview' },
      { text: 'DNS', link: '/dns/overview' },
      { text: 'Implementation', link: '/implementation/checklist' },
    ],
    sidebar: {
      '/': [
        {
          text: 'Architecture',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/architecture/overview' },
            { text: 'Box Lifecycle', link: '/architecture/lifecycle' },
            { text: 'Adapter Interfaces', link: '/architecture/adapters' },
            { text: 'Service Registry', link: '/architecture/service-registry' },
            { text: 'Router & Rules', link: '/architecture/router' },
            { text: 'Connection Manager', link: '/architecture/connection' },
            { text: 'Network Manager', link: '/architecture/network' },
            { text: 'Dialer System', link: '/architecture/dialer' },
            { text: 'Listener System', link: '/architecture/listener' },
            { text: 'Sniffing', link: '/architecture/sniffing' },
          ],
        },
        {
          text: 'Proxy Protocols',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/protocols/overview' },
            { text: 'VLESS', link: '/protocols/vless' },
            { text: 'VMess', link: '/protocols/vmess' },
            { text: 'Trojan', link: '/protocols/trojan' },
            { text: 'Shadowsocks', link: '/protocols/shadowsocks' },
            { text: 'ShadowTLS', link: '/protocols/shadowtls' },
            { text: 'Hysteria2', link: '/protocols/hysteria2' },
            { text: 'TUIC', link: '/protocols/tuic' },
            { text: 'AnyTLS', link: '/protocols/anytls' },
            { text: 'NaiveProxy', link: '/protocols/naive' },
            { text: 'WireGuard', link: '/protocols/wireguard' },
            { text: 'SOCKS / HTTP / Mixed', link: '/protocols/socks-http' },
            { text: 'Direct / Block / DNS', link: '/protocols/direct-block-dns' },
            { text: 'Redirect / TProxy', link: '/protocols/redirect-tproxy' },
            { text: 'TUN', link: '/protocols/tun' },
            { text: 'Outbound Groups', link: '/protocols/groups' },
            { text: 'SSH / Tor / Tailscale', link: '/protocols/ssh-tor-tailscale' },
          ],
        },
        {
          text: 'Transport Layer',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/transport/overview' },
            { text: 'V2Ray Transports', link: '/transport/v2ray' },
            { text: 'WebSocket', link: '/transport/websocket' },
            { text: 'gRPC', link: '/transport/grpc' },
            { text: 'HTTP / HTTPUpgrade', link: '/transport/http' },
            { text: 'QUIC', link: '/transport/quic' },
            { text: 'TLS / uTLS / REALITY', link: '/transport/tls' },
            { text: 'kTLS', link: '/transport/ktls' },
            { text: 'Multiplex (smux)', link: '/transport/mux' },
            { text: 'UDP over TCP', link: '/transport/uot' },
            { text: 'TLS Fragmentation', link: '/transport/tls-fragment' },
          ],
        },
        {
          text: 'DNS System',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/dns/overview' },
            { text: 'Client & Router', link: '/dns/client-router' },
            { text: 'Transport Types', link: '/dns/transports' },
            { text: 'FakeIP', link: '/dns/fakeip' },
            { text: 'Hosts & Local', link: '/dns/hosts-local' },
            { text: 'Caching & EDNS0', link: '/dns/caching' },
          ],
        },
        {
          text: 'Advanced Features',
          collapsed: false,
          items: [
            { text: 'Rule Sets (SRS)', link: '/advanced/rule-sets' },
            { text: 'GeoIP / GeoSite', link: '/advanced/geo' },
            { text: 'Process Matching', link: '/advanced/process' },
            { text: 'Clash API', link: '/advanced/clash-api' },
            { text: 'V2Ray API', link: '/advanced/v2ray-api' },
            { text: 'Cache File', link: '/advanced/cache' },
            { text: 'Platform / libbox', link: '/advanced/platform' },
          ],
        },
        {
          text: 'Configuration',
          collapsed: false,
          items: [
            { text: 'Config Structure', link: '/config/structure' },
            { text: 'Option Types', link: '/config/types' },
            { text: 'Build Tags', link: '/config/build-tags' },
          ],
        },
        {
          text: 'Implementation',
          collapsed: false,
          items: [
            { text: 'Checklist', link: '/implementation/checklist' },
            { text: 'Compatibility Notes', link: '/implementation/compatibility' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/SagerNet/sing-box' },
    ],
    outline: {
      level: [2, 3],
    },
  },
  markdown: {
    lineNumbers: true,
  },
})
