'use strict';

const { BlockList, isIP } = require('node:net');

const forwardingHeaders = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];

const nonPublic = new BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
	['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
	['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
	['224.0.0.0', 4], ['240.0.0.0', 4], ['::', 128], ['::1', 128],
	['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) {
	nonPublic.addSubnet(address, prefix, family(address));
}

function family(ip) {
	return isIP(ip) === 4 ? 'ipv4' : 'ipv6';
}

function address(value) {
	const ip = typeof value === 'string' ? value.trim() : '';
	return !ip.includes('%') && isIP(ip) ? ip : '';
}

function forwardedNode(value) {
	const node = value.trim();
	const portAddress = node.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/u) ||
		node.match(/^([^:]+):(\d{1,5})$/u);
	return address(node) || (portAddress && Number(portAddress[2] || 0) <= 65535
		? address(portAddress[1]) : '');
}

function splitQuoted(value, delimiter) {
	const parts = [''];
	for (const token of value.match(/"[^"]*"|[^",;]+|[,;]/gu) || []) {
		if (token === delimiter) {
			parts.push('');
		} else {
			parts[parts.length - 1] += token;
		}
	}
	return parts;
}

function forwardedChain(header) {
	if (/[^\x09\x20-\x7e]|[\\]/u.test(header) || (header.match(/"/gu) || []).length % 2) {
		return [];
	}
	return splitQuoted(header, ',').map((element) => {
		const pairs = splitQuoted(element, ';').map(parameter =>
			parameter.trim().match(/^([a-z0-9_-]+)=(?:"([^"]*)"|([^"\s]+))$/iu));
		if (!pairs.every(Boolean)) {
			return '';
		}
		const matches = pairs.filter(pair => pair[1].toLowerCase() === 'for');
		return matches.length === 1 ? forwardedNode(matches[0][2] ?? matches[0][3]) : '';
	});
}

function resolveClientIp(request, nativeIp) {
	const peer = address(request.socket?.remoteAddress);
	const native = address(nativeIp) || address(request.ip);
	const fallback = native || peer;
	if ((native && !nonPublic.check(native, family(native))) || !peer || !nonPublic.check(peer, family(peer))) {
		return fallback;
	}

	const peerAddresses = new BlockList();
	peerAddresses.addAddress(peer, family(peer));
	const headers = request.headers || {};
	for (const name of forwardingHeaders) {
		const value = headers[name];
		if (typeof value !== 'string' || !value || value.length > 8192) {
			continue;
		}
		const chain = name === 'forwarded' ? forwardedChain(value) :
			(name === 'x-forwarded-for' ? value.split(',').map(forwardedNode) : [address(value)]);
		if (chain.length && chain.every(Boolean)) {
			const visitor = chain.findLast(ip => !peerAddresses.check(ip, family(ip)));
			if (visitor) {
				return visitor;
			}
		}
	}
	return fallback;
}

module.exports = { forwardingHeaders, resolveClientIp };
