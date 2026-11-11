import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const bundledCli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
function read(...args) {
  const { DEEPSEEK_API_KEY: _key, ...env } = process.env;
  const options = {
    encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, TAILSCALE_BE_CLI: '1' },
  };
  let output;
  try { output = execFileSync('tailscale', args, options); }
  catch (error) {
    if (error.code !== 'ENOENT' || !existsSync(bundledCli)) throw error;
    output = execFileSync(bundledCli, args, options);
  }
  return JSON.parse(output.trim() || '{}');
}

function portOccupied(config, port) {
  const addressUsesPort = key => key.endsWith(':' + port);
  return Boolean(config.TCP?.[port] ||
    Object.keys(config.Web ?? {}).some(addressUsesPort) ||
    Object.keys(config.AllowFunnel ?? {}).some(addressUsesPort) ||
    Object.values(config.Foreground ?? {}).some(child => portOccupied(child, port)) ||
    Object.values(config.Services ?? {}).some(child => portOccupied(child, port)));
}

try {
  const port = process.argv[2] ?? '443';
  if (process.argv.length > 3 || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error('用法：node scripts/tailnet-check.mjs [HTTPS 端口]');
  }
  const status = read('status', '--json');
  if (status.BackendState !== 'Running' || !status.Self?.Online) throw new Error('请先在 Mac 上连接 Tailscale');
  const hostname = status.Self.DNSName?.replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(hostname ?? '') || !status.CertDomains?.includes(hostname)) {
    throw new Error('请在 Tailscale 管理控制台启用 MagicDNS 和 HTTPS Certificates');
  }
  if (portOccupied(read('serve', 'status', '--json') ?? {}, port)) {
    throw new Error('Tailnet ' + port + ' 端口已有配置，请选择其他端口');
  }
  console.log('AI_OFFICE_ORIGIN=https://' + hostname + (port === '443' ? '' : ':' + port));
} catch (error) {
  const message = error.code === 'ENOENT' ? '未找到 Tailscale，请按安装指南安装 Mac 端和 CLI' :
    'status' in error ? '无法读取本机 Tailscale 状态，请确认应用已连接' : error.message;
  console.error('预检未通过。' + message);
  process.exitCode = 2;
}
