import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:dns', () => ({ lookup: vi.fn() }));

import { lookup } from 'node:dns';
import { assertFetchableTarget, isPrivateAddress } from './ssrf.js';

const mockedLookup = vi.mocked(lookup);

function mockDns(addresses: Array<{ address: string; family: number }>) {
  mockedLookup.mockImplementation(((_hostname: string, _options: unknown, callback: unknown) => {
    (callback as (err: unknown, addrs: unknown) => void)(null, addresses);
  }) as never);
}

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local and CGNAT blocks', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '100.127.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('flags special-use / non-global IPv4 blocks', () => {
    for (const ip of [
      '198.18.0.1', // benchmark 198.18.0.0/15
      '198.19.255.255',
      '192.0.0.1', // IETF protocol assignments
      '192.0.2.1', // TEST-NET-1
      '198.51.100.1', // TEST-NET-2
      '203.0.113.1', // TEST-NET-3
      '224.0.0.1', // multicast
      '240.0.0.1', // reserved
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('flags IPv6 special-use blocks', () => {
    for (const ip of [
      'fe80::1', // link-local fe80::/10
      'febf::1',
      'fec0::1', // site-local fec0::/10 (deprecated)
      'feff::1',
      'fc00::1', // unique local fc00::/7
      'fd12:3456:789a::1',
      'ff02::1', // multicast ff00::/8
      '2001:db8::1', // documentation 2001:db8::/32
      '::ffff:10.0.0.1', // v4-mapped private
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '172.32.0.1',
      '198.20.0.1',
      '203.0.114.1',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertFetchableTarget', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('rejects a hostname whose DNS answers mix public and private records', async () => {
    mockDns([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(assertFetchableTarget('http://mixed.example')).rejects.toThrow(/private\/internal/);
  });

  it('accepts an all-public hostname', async () => {
    mockDns([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertFetchableTarget('http://public.example')).resolves.toBeInstanceOf(URL);
  });

  it('rejects literal private hosts and non-http(s) schemes', async () => {
    await expect(assertFetchableTarget('http://127.0.0.1/')).rejects.toThrow(/private\/internal/);
    await expect(assertFetchableTarget('http://198.18.0.1/')).rejects.toThrow(/private\/internal/);
    await expect(assertFetchableTarget('file:///etc/passwd')).rejects.toThrow(/Blocked scheme/);
  });

  it('accepts a literal public IP without a DNS lookup', async () => {
    await expect(assertFetchableTarget('https://93.184.216.34/')).resolves.toBeInstanceOf(URL);
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});
