// SyncSpace Client Configuration for GitHub Pages Deployment
// If a custom server parameter is passed in the URL (?server=wss://...), it takes precedence.
// Otherwise, it connects to the production Render backend.
(function() {
  var params = new URLSearchParams(window.location.search);
  var customServer = params.get('server');
  if (customServer) {
    window.SYNCSPACE_URL = customServer;
  } else if (!window.SYNCSPACE_URL) {
    window.SYNCSPACE_URL = "wss://syncspace-backend.onrender.com";
  }
})();
