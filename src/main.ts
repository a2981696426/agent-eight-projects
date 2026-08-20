import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/responsive.css'
import { initEnhancements } from './interactions/index.js'

const cleanup = initEnhancements()

if (import.meta.hot) import.meta.hot.dispose(cleanup)
