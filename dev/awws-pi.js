/*
 * The Pi's hub server (pi/server.js) with its clock moved, for the A World
 * Worth Saving tests and screenshots: node dev/awws-pi.js '<options JSON>'
 *
 * The screenshots fix the TV's clock (Monday 16 November 2026, 10:40 AM in
 * Chicago). The Pi refuses a snapshot whose sentAt is in its future, so the
 * server here runs as if it were that moment too: options.at (UTC ms) is
 * "now" when it starts, and the clock moves on from there. Every other
 * option goes to server.start (port, token, origins, dataDir, calendars,
 * allowHttp, timezone). Prints "ready <port>" once it listens.
 * Started by dev/awws-sample.js startPi(); not meant to run by hand.
 */
'use strict';

const path = require('path');

const opts = JSON.parse(process.argv[2] || '{}');
if (typeof opts.at === 'number') {
  const realNow = Date.now;
  const offset = opts.at - realNow();
  Date.now = () => realNow() + offset;
}
delete opts.at;
opts.now = () => new Date(Date.now());
opts.log = false;

const server = require(path.join(__dirname, '..', 'pi', 'server.js')).start(opts);
Promise.resolve(server.ready).then(() => {
  process.stdout.write('ready ' + opts.port + '\n');
});
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); });
