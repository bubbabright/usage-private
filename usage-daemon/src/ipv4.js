// Force IPv4-only outbound connects for this process.
//
// Host IPv6 is broken / not required (lab policy). Providers that publish AAAA
// records (api.anthropic.com, cli-chat-proxy.grok.com, Cloudflare edges) make
// Node's undici `fetch` dual-stack attempt hang until ConnectTimeoutError.
// Hosts with only A (e.g. ollama.com today) still work without this patch —
// which looked like "cookie auth works, oauth-file broken" until we dug in.
//
// Import this module first from index.js, before any provider fetch runs.
// Zero deps: monkey-patches dns.lookup (what undici uses for connect).

import dns from 'node:dns';

const origLookup = dns.lookup.bind(dns);

function lookupIpv4(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  } else if (typeof options === 'number') {
    options = { family: options };
  } else {
    options = { ...(options || {}) };
  }
  options.family = 4;
  return origLookup(hostname, options, callback);
}

dns.lookup = lookupIpv4;

if (dns.promises?.lookup) {
  const origPromiseLookup = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = (hostname, options = {}) => {
    if (typeof options === 'number') options = { family: options };
    return origPromiseLookup(hostname, { ...options, family: 4 });
  };
}

// Prefer A over AAAA if anything still goes through default resolution.
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
