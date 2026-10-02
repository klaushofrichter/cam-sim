import { tmpdir } from 'os';
import { join } from 'path';

// Test-only values for the e2e simulator; not secrets.
export const TOKEN = 'e2e-control-token-not-a-secret';
// Saved by auth.setup.ts: the signed-in session shared by the specs.
export const STATE_FILE = join(__dirname, '.auth', 'state.json');
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
  CAMSIM_RTSP_PORT: '18554',
  CAMSIM_ONVIF_PORT: '18000',
  CAMSIM_BAICHUAN_PORT: '19000',
  CAMSIM_LOG_LEVEL: 'warn',
  // A generated video besides the test pattern (e2e/make-library.mjs).
  CAMSIM_LIBRARY_DIR: join(tmpdir(), 'cam-sim-e2e-library'),
  CAMSIM_MAIN_SIZE: '640x360',
  // Not a preset of the SD pipeline card: it becomes its last choice.
  CAMSIM_PIPELINE_MAX_MIN: '300',
};
