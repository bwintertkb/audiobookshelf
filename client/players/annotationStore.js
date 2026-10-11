import { AnnotationStore } from './annotations'

let store = null
let storeAxios = null

/** The annotation store of the web client (online only: changes that fail are reported, not queued) */
export function getAnnotationStore(axios) {
  if (!store) {
    store = new AnnotationStore({
      request: null,
      isPermanentError: (error) => error?.response?.status >= 400 && error.response.status < 500
    })
  }
  if (axios !== storeAxios) {
    // The same $axios in the app; component tests mount with their own
    storeAxios = axios
    store.request = (method, url, data) => axios.$request({ method, url, data, progress: false })
  }
  return store
}
