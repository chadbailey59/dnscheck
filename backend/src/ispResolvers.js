'use strict';

const OTHER_PROVIDER = 'Other';

const ISP_RESOLVER_GROUPS = [
  {
    provider: 'AT&T',
    aliases: ['at&t', 'at t', 'att', 'sbc', 'sbcglobal', 'pacbell', 'swbell', 'ameritech', 'prodigy', 'as7018'],
    servers: ['68.94.156.1', '68.94.157.1'],
  },
  {
    provider: 'AT&T (BellSouth SE)',
    aliases: ['bellsouth', 'at&t bellsouth'],
    servers: ['205.152.37.23', '205.152.144.23', '205.152.132.23'],
  },
  {
    provider: 'Comcast/Xfinity',
    aliases: ['comcast', 'xfinity', 'as7922'],
    servers: ['75.75.75.75', '75.75.76.76'],
  },
  {
    provider: 'Cox',
    aliases: ['cox', 'cox.net', 'as22773'],
    servers: ['68.105.28.11', '68.105.29.11'],
  },
  {
    provider: 'Charter/Spectrum',
    aliases: ['charter', 'spectrum', 'rr.com', 'twc', 'twcable', 'brighthouse', 'bright house', 'as20115', 'as7843'],
    servers: ['209.18.47.61', '209.18.47.62', '71.10.216.1', '71.10.216.2'],
  },
  {
    provider: 'CenturyLink/Lumen',
    aliases: ['centurylink', 'lumen', 'qwest', 'level 3', 'level3', 'as209', 'as3356'],
    servers: ['205.171.3.65', '205.171.2.65'],
  },
  {
    provider: 'Verizon/Level3',
    aliases: ['verizon', 'fios', 'alter.net', 'mci', 'as701', 'as6167'],
    servers: ['4.2.2.1', '4.2.2.2'],
  },
];

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9&.]+/g, ' ').trim();
}

function isOtherProvider(value) {
  return normalize(value) === normalize(OTHER_PROVIDER);
}

function findResolverGroup(providerOrEvidence) {
  const evidence = normalize(providerOrEvidence);
  if (!evidence) return null;

  return ISP_RESOLVER_GROUPS.find(group => {
    if (normalize(group.provider) === evidence) return true;
    return group.aliases.some(alias => evidence.includes(normalize(alias)));
  }) ?? null;
}

// Returns all groups whose provider name or aliases match — used by the contributor
// so that ISP_PROVIDER=AT&T probes both 'AT&T' and 'AT&T (BellSouth SE)'.
function findResolverGroups(providerOrEvidence) {
  const evidence = normalize(providerOrEvidence);
  if (!evidence) return [];

  return ISP_RESOLVER_GROUPS.filter(group => {
    if (normalize(group.provider) === evidence) return true;
    if (normalize(group.provider).includes(evidence)) return true;
    return group.aliases.some(alias => evidence.includes(normalize(alias)));
  });
}

function listProviderNames() {
  return [...ISP_RESOLVER_GROUPS.map(group => group.provider), OTHER_PROVIDER];
}

module.exports = { ISP_RESOLVER_GROUPS, OTHER_PROVIDER, findResolverGroup, findResolverGroups, isOtherProvider, listProviderNames };
