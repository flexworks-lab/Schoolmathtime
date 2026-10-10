// Schoolmathtime Ultraviolet configuration.
// The client and service worker are served from this same HTTPS origin.
self.__uv$config = {
  prefix: "/uv/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/uv.handler.js",
  client: "/uv/uv.client.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv/uv.config.js",
  sw: "/uv/uv.sw.js",
  // Ultraviolet supports per-host HTML injection. Keep this CSS scoped to
  // YouTube so it does not affect other proxied websites.
  inject: [
    {
      host: "(^|\\.)youtube\\.com$",
      injectTo: "head",
      html: '<style id="stm-uv-youtube-layout">html,body{width:100%!important;min-width:0!important;max-width:100%!important;overflow-x:hidden!important}body{margin:0!important}ytd-app,#page-manager,#content,#columns,#primary,#secondary,ytd-watch-flexy,ytd-browse,ytd-search,ytd-two-column-browse-results-renderer{box-sizing:border-box!important;min-width:0!important;max-width:100%!important}#masthead-container{z-index:2200!important}#player-container-outer,#player-container-inner,#player,#movie_player,#below,#related,#comments{max-width:100%!important}#player-container-inner{width:100%!important}#movie_player video.html5-main-video{max-width:100%!important}@media(max-width:800px){#columns.ytd-watch-flexy{display:flex!important;flex-direction:column!important}#primary,#secondary{width:100%!important;max-width:100%!important}#secondary{min-width:0!important}#player-container-inner{min-width:0!important}}</style>'
    },
    {
      host: "(^|\\.)youtube-nocookie\\.com$",
      injectTo: "head",
      html: '<style id="stm-uv-youtube-embed-layout">html,body{width:100%!important;min-width:0!important;max-width:100%!important;overflow:hidden!important;margin:0!important}body,#movie_player,#player-container{height:100%!important;max-width:100%!important}video{max-width:100%!important}</style>'
    }
  ]
};
