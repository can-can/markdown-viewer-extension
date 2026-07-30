/**
 * Firefox Popup Entry Point
 * Initialize Firefox platform before loading shared popup
 */

// Initialize Firefox platform FIRST
import '../webview/index';

// Import and initialize shared popup
import { initializePopup } from '../../../src/ui/popup/popup-core';

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  initializePopup();

  // Firefox does not support workspace — hide the entry button
  const projectBtn = document.getElementById('open-project-btn');
  if (projectBtn) projectBtn.style.display = 'none';
});
