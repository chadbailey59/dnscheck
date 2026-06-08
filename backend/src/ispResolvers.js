'use strict';

const ISP_RESOLVER_GROUPS = [
  {
    provider: 'AT&T',
    aliases: ['at&t', 'at t', 'att', 'sbc', 'sbcglobal', 'bellsouth', 'pacbell', 'swbell', 'ameritech', 'prodigy', 'as7018'],
    servers: ['68.94.156.1', '68.94.157.1', '205.152.37.23', '205.152.144.23', '205.152.132.23'],
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

function findResolverGroup(providerOrEvidence) {
  const evidence = normalize(providerOrEvidence);
  if (!evidence) return null;

  return ISP_RESOLVER_GROUPS.find(group => {
    if (normalize(group.provider) === evidence) return true;
    return group.aliases.some(alias => evidence.includes(normalize(alias)));
  }) ?? null;
}

function listProviderNames() {
  return ISP_RESOLVER_GROUPS.map(group => group.provider);
}

module.exports = { ISP_RESOLVER_GROUPS, findResolverGroup, listProviderNames };
