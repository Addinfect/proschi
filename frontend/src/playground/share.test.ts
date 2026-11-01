import { describe, expect, it } from 'vitest';
import { ecommerceExample } from '../dsl';
import { decodeShareHash, decodeShareLink, encodeShareHash, shareUrl } from './share';

describe('share links', () => {
  it('round-trips a document through the hash', () => {
    const hash = encodeShareHash(ecommerceExample);
    expect(hash.startsWith('#code=')).toBe(true);
    expect(hash).toMatch(/^#code=[A-Za-z0-9+\-$]*$/);
    expect(decodeShareHash(hash)).toBe(ecommerceExample);
  });

  it('keeps unicode and payload characters intact', () => {
    const src = 'title "Café ☕"\na -> b : POST /x {"q": "#1 & 2"}';
    expect(decodeShareHash(encodeShareHash(src))).toBe(src);
  });

  it('ignores other or corrupt hashes', () => {
    expect(decodeShareHash('')).toBeNull();
    expect(decodeShareHash('#other=1')).toBeNull();
    expect(decodeShareHash('#code=')).toBeNull();
    expect(decodeShareHash('#code=%%%not-lz')).toBeNull();
  });

  it('builds a full URL that keeps the page path', () => {
    const url = shareUrl('a -> b', { origin: 'https://gvart.github.io', pathname: '/proschi/', search: '' });
    expect(url.startsWith('https://gvart.github.io/proschi/#code=')).toBe(true);
  });
});

describe('playback deep links', () => {
  it('round-trips a use case and step', () => {
    const hash = encodeShareHash('a -> b', { useCase: 'log-in', step: 3 });
    expect(hash).toMatch(/&uc=log-in&step=3$/);
    expect(decodeShareLink(hash)).toEqual({ source: 'a -> b', playback: { useCase: 'log-in', step: 3 } });
    expect(decodeShareHash(hash)).toBe('a -> b');
  });

  it('defaults a missing or bad step to 1', () => {
    const code = encodeShareHash('x');
    expect(decodeShareLink(`${code}&uc=u`)?.playback).toEqual({ useCase: 'u', step: 1 });
    expect(decodeShareLink(`${code}&uc=u&step=-2`)?.playback).toEqual({ useCase: 'u', step: 1 });
    expect(decodeShareLink(`${code}&uc=u&step=abc`)?.playback).toEqual({ useCase: 'u', step: 1 });
  });

  it('round-trips a scenario', () => {
    const hash = encodeShareHash('a -> b', { useCase: 'create-order', scenario: 'db-down', step: 2 });
    expect(hash).toMatch(/&uc=create-order&alt=db-down&step=2$/);
    expect(decodeShareLink(hash)?.playback).toEqual({ useCase: 'create-order', scenario: 'db-down', step: 2 });
  });

  it('has no playback without a use case', () => {
    expect(decodeShareLink(encodeShareHash('x'))).toEqual({ source: 'x' });
  });

  it('includes playback in full URLs', () => {
    expect(shareUrl('x', { origin: 'https://h', pathname: '/p/', search: '' }, { useCase: 'u', step: 2 })).toMatch(/^https:\/\/h\/p\/#code=.*&uc=u&step=2$/);
  });
});

describe('imported files in links', () => {
  const imports = { 'infra.proschi': 'title "Infra"\napi [REST API] "Uses + & # = signs"', 'teams/db.proschi': 'db [Redis]' };

  it('round-trips imported sources alongside playback', () => {
    const hash = encodeShareHash('import "infra.proschi"', { useCase: 'u', scenario: 's', step: 2 }, imports);
    expect(hash).toMatch(/^#code=[^&]+&imports=[A-Za-z0-9+\-$]+&uc=u&alt=s&step=2$/);
    expect(decodeShareLink(hash)).toEqual({ source: 'import "infra.proschi"', imports, playback: { useCase: 'u', scenario: 's', step: 2 } });
    expect(decodeShareLink(encodeShareHash('x', undefined, imports))).toEqual({ source: 'x', imports });
    expect(shareUrl('x', { origin: 'https://h', pathname: '/', search: '' }, undefined, imports)).toContain('&imports=');
  });

  it('leaves the parameter out when there is nothing to import', () => {
    expect(encodeShareHash('x', undefined, {})).toBe(encodeShareHash('x'));
  });

  it('ignores a corrupt or malformed imports parameter', () => {
    const code = encodeShareHash('x');
    expect(decodeShareLink(`${code}&imports=%%%`)).toEqual({ source: 'x' });
    expect(decodeShareLink(`${code}&imports=${encodeShareHash('[1,2]').slice(6)}`)).toEqual({ source: 'x' });
  });

  it('drops imported files under keys no import resolves to', () => {
    const imports = { 'ok.proschi': 'a', '/etc/passwd': 'b', 'http://example.com/x.proschi': 'c', 'git:github.com/acme/infra//x.proschi@v1': 'd' };
    expect(decodeShareLink(encodeShareHash('x', undefined, imports))?.imports).toEqual({ 'ok.proschi': 'a', 'git:github.com/acme/infra//x.proschi@v1': 'd' });
    expect(decodeShareLink(encodeShareHash('x', undefined, { '/etc/passwd': 'b' }))).toEqual({ source: 'x' });
  });

  it('keeps links made before imports existed working', () => {
    // A link in the format the editor wrote before imports existed.
    const old = '#code=IYAgtAfCBGQ&uc=log-in&alt=db-down&step=3';
    expect(decodeShareLink(old)).toEqual({ source: 'a -> b', playback: { useCase: 'log-in', scenario: 'db-down', step: 3 } });
  });
});
