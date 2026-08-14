const matchMedia = (query) => ({
  addEventListener: () => {},
  addListener: () => {},
  dispatchEvent: () => false,
  matches: false,
  media: query,
  onchange: null,
  removeEventListener: () => {},
  removeListener: () => {},
});

Object.defineProperty(globalThis, 'matchMedia', {
  configurable: true,
  value: matchMedia,
  writable: true,
});
