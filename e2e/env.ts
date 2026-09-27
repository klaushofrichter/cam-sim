// Test-only values for the e2e simulator; not secrets.
export const TOKEN = 'e2e-control-token-not-a-secret';
export const UI_PORT = 19443;
export const CAM_PORT = 18080;
export const CAM_USER = 'e2e';
export const CAM_PASSWORD = 'e2e-not-a-real-password';

export const SIM_ENV: Record<string, string> = {
  CAMSIM_USERS: `${CAM_USER}:admin:${CAM_PASSWORD}`,
  CAMSIM_CONTROL_TOKEN: TOKEN,
  CAMSIM_WEB_UI: 'true',
  CAMSIM_NAME: 'e2e-cam',
  CAMSIM_SEED_CLIPS: 'demo',
  CAMSIM_HTTP_PORT: String(CAM_PORT),
  CAMSIM_HTTPS_PORT: '18443',
  CAMSIM_CONTROL_PORT: String(UI_PORT),
  CAMSIM_LOG_LEVEL: 'warn',
};
