import { execFileSync } from 'node:child_process'
import { getInfo } from './input.js'

const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export function checkPermissions() {
  const info = getInfo()
  return {
    accessibility: info.accessibility,
    screenRecording: info.screenRecording,
    instructions: [
      info.accessibility ? null : 'Accessibility missing: System Settings > Privacy & Security > Accessibility > enable your terminal app, then restart the terminal.',
      info.screenRecording ? null : 'Screen Recording missing: System Settings > Privacy & Security > Screen Recording > enable your terminal app, then restart the terminal.',
    ].filter(Boolean),
  }
}

export function setupPermissions() {
  const opened: string[] = []
  try {
    execFileSync('open', [ACCESSIBILITY_PANE], { stdio: 'pipe' })
    opened.push('opened Accessibility settings')
  } catch {}
  try {
    execFileSync('open', [SCREEN_RECORDING_PANE], { stdio: 'pipe' })
    opened.push('opened Screen Recording settings')
  } catch {}
  return {
    ok: true,
    opened,
    next: 'Enable your terminal app under Accessibility and Screen Recording, then restart the terminal. Run check_permissions afterwards to verify.',
  }
}
