import type { DeeprojectApi } from './index'

declare global {
  interface Window {
    api: DeeprojectApi
  }
}

export {}
