'use strict';
// Wake-on-LAN magic packet sender (replaces the unmaintained "wake_on_lan"
// package with the same behaviour: 3 packets, 100 ms apart, UDP port 9,
// broadcast enabled). Built only on Node's dgram module.
const dgram = require('dgram');
const net = require('net');

function createMagicPacket(mac) {
  let m = String(mac || '').trim();
  if (m.length === 17) m = m.split(m[2]).join(''); // aa:bb:.. / aa-bb-..
  if (!/^[0-9a-fA-F]{12}$/.test(m)) throw new Error("malformed MAC address '" + mac + "'");
  const macBuf = Buffer.from(m, 'hex');
  const packet = Buffer.alloc(17 * 6, 0xff);
  for (let i = 1; i <= 16; i++) macBuf.copy(packet, i * 6);
  return packet;
}

function wake(mac, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = undefined; }
  opts = opts || {};
  const address = opts.address || '255.255.255.255';
  const count = opts.num_packets || 3;
  const interval = opts.interval || 100;
  const port = opts.port || 9;
  let packet;
  try { packet = createMagicPacket(mac); } catch (e) { if (callback) process.nextTick(callback, e); return; }

  const socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4');
  let sent = 0; let timer = null; let finished = false;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    try { socket.close(); } catch (e) { err = err || e; }
    if (callback) callback(err || undefined);
  };
  socket.on('error', finish);
  socket.once('listening', () => { try { socket.setBroadcast(true); } catch (e) { /* ignored */ } });
  const send = () => {
    if (finished) return;
    sent++;
    const last = sent >= count;
    socket.send(packet, 0, packet.length, port, address, (err) => { if (err || last) finish(err); });
    if (!last) timer = setTimeout(send, interval);
  };
  send();
}

module.exports = { wake, createMagicPacket };
