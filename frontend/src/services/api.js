const BASE_URL = import.meta.env.VITE_API_BASE_URL || ''
export const AUTH_EXPIRED_EVENT = 'finanalytica:auth-expired'

function clearStoredAuth() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
}

function getActiveProjectId() {
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null')
    return user?.active_project_id || ''
  } catch {
    return ''
  }
}

function isAuthRoute(path) {
  return path.startsWith('/api/v1/auth/')
}

function getErrorMessage(status, body = {}) {
  return body.error || body.detail || `HTTP ${status}`
}

function handleUnauthorized(path, status, message) {
  if (status !== 401 || isAuthRoute(path)) {
    return message
  }

  clearStoredAuth()
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, {
    detail: { message },
  }))
  return 'Сессия истекла. Войдите снова.'
}

async function readErrorMessage(res, path) {
  const body = await res.json().catch(() => ({}))
  const message = getErrorMessage(res.status, body)
  return handleUnauthorized(path, res.status, message)
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Превышено время ожидания ответа сервера')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

async function request(path, options = {}, timeoutMs = 30000) {
  const token = localStorage.getItem('token')
  const headers = { 'Content-Type': 'application/json', ...options.headers }
  if (token) headers.Authorization = `Bearer ${token}`
  const activeProjectId = getActiveProjectId()
  if (activeProjectId && !headers['X-Project-Id']) {
    headers['X-Project-Id'] = activeProjectId
  }

  const res = await fetchWithTimeout(`${BASE_URL}${path}`, { ...options, headers }, timeoutMs)
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path))
  }
  return res.json()
}

/* -- Auth -- */

export async function login(email, password) {
  return request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function register(email, password) {
  return request('/api/v1/auth/register/send-code', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function confirmRegistration(email, code) {
  return request('/api/v1/auth/register/confirm', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  })
}

export async function registerLegacy(email, password) {
  return request('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function logout() {
  return request('/api/v1/auth/logout', { method: 'POST' })
}

export async function fetchProjects() {
  return request('/api/v1/projects')
}

export async function createProject(name) {
  return request('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function activateProject(projectId) {
  return request(`/api/v1/projects/${projectId}/activate`, {
    method: 'POST',
  })
}

export async function deleteProject(projectId) {
  return request(`/api/v1/projects/${projectId}`, {
    method: 'DELETE',
  })
}

export async function fetchProjectFiles(projectId) {
  return request(`/api/v1/projects/${projectId}/files`)
}

export async function fetchImportWarnings() {
  return { fraud_warnings: [] }
}

export async function importStatement(file, parserType = 'kaspi') {
  const token = localStorage.getItem('token')
  const path = '/api/v1/transactions/import-statement'
  const formData = new FormData()
  formData.append('file', file)
  formData.append('parser_type', parserType)

  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const activeProjectId = getActiveProjectId()
  if (activeProjectId) headers['X-Project-Id'] = activeProjectId

  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  }, 180000)

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path))
  }

  return res.json()
}

/* -- Transactions -- */

function appendSharedFilters(params, filters = {}) {
  if (filters.date) params.set('date', filters.date)
  if (filters.category) params.set('category', filters.category)
  if (filters.search) params.set('search', filters.search)
  if (filters.minAmount) params.set('min_amount', filters.minAmount)
  if (filters.maxAmount) params.set('max_amount', filters.maxAmount)
  if (filters.currency) params.set('currency', filters.currency)
  if (filters.sender) params.set('sender', filters.sender)
  if (filters.recipient) params.set('recipient', filters.recipient)
}

export async function fetchTransactions(filters = {}) {
  const params = new URLSearchParams()

  appendSharedFilters(params, filters)
  if (filters.scope) params.set('scope', filters.scope)
  if (filters.sortBy) params.set('sort_by', filters.sortBy)
  if (filters.sortDir) params.set('sort_dir', filters.sortDir)
  if (filters.page) params.set('page', filters.page)
  if (filters.perPage) params.set('per_page', filters.perPage)

  const qs = params.toString()
  return request(`/api/v1/transactions${qs ? `?${qs}` : ''}`)
}

function appendEsfFilters(params, filters = {}) {
  if (filters.date) params.set('date', filters.date)
  if (filters.search) params.set('search', filters.search)
  if (filters.currency) params.set('currency', filters.currency)
  if (filters.sender) params.set('sender', filters.sender)
  if (filters.recipient) params.set('recipient', filters.recipient)
  if (filters.direction) params.set('direction', filters.direction)
}

export async function fetchEsfRecords(filters = {}) {
  const params = new URLSearchParams()

  appendEsfFilters(params, filters)
  if (filters.sortBy) params.set('sort_by', filters.sortBy)
  if (filters.sortDir) params.set('sort_dir', filters.sortDir)
  if (filters.page) params.set('page', filters.page)
  if (filters.perPage) params.set('per_page', filters.perPage)

  const qs = params.toString()
  return request(`/api/v1/transactions/esf${qs ? `?${qs}` : ''}`)
}

export async function exportTransactionsExcel(filters = {}) {
  const token = localStorage.getItem('token')
  const path = '/api/v1/transactions/export'
  const params = new URLSearchParams()

  appendSharedFilters(params, filters)
  if (filters.scope) params.set('scope', filters.scope)

  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const activeProjectId = getActiveProjectId()
  if (activeProjectId) headers['X-Project-Id'] = activeProjectId

  const qs = params.toString()
  const res = await fetchWithTimeout(`${BASE_URL}${path}${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers,
  }, 60000)

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path))
  }

  return res.blob()
}

export async function exportEsfExcel(filters = {}) {
  const token = localStorage.getItem('token')
  const path = '/api/v1/transactions/esf/export'
  const params = new URLSearchParams()

  appendEsfFilters(params, filters)

  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const activeProjectId = getActiveProjectId()
  if (activeProjectId) headers['X-Project-Id'] = activeProjectId

  const qs = params.toString()
  const res = await fetchWithTimeout(`${BASE_URL}${path}${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers,
  }, 60000)

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, path))
  }

  return res.blob()
}

export async function fetchEsfSummarySheet(filters = {}) {
  const params = new URLSearchParams()

  appendEsfFilters(params, filters)
  if (filters.page) params.set('page', filters.page)
  if (filters.perPage) params.set('per_page', filters.perPage)

  const qs = params.toString()
  return request(`/api/v1/transactions/esf/summary${qs ? `?${qs}` : ''}`)
}

export async function fetchEsfTruSummarySheet(filters = {}) {
  const params = new URLSearchParams()

  appendEsfFilters(params, filters)
  if (filters.page) params.set('page', filters.page)
  if (filters.perPage) params.set('per_page', filters.perPage)

  const qs = params.toString()
  return request(`/api/v1/transactions/esf/tru-summary${qs ? `?${qs}` : ''}`)
}


/* -- Analytics -- */

export async function fetchTimeSeries(period = 'month', dateFrom, dateTo, filters = {}) {
  const params = new URLSearchParams({ period })
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/time-series?${params}`)
}

export async function fetchTimeSeriesTransactions(period = 'month', bucket, limit = 200, filters = {}) {
  const params = new URLSearchParams({ period, bucket, limit: String(limit) })
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/time-series-transactions?${params}`)
}

export async function fetchSummary(dateFrom, dateTo, filters = {}) {
  const params = new URLSearchParams()
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  appendSharedFilters(params, filters)
  const qs = params.toString()
  return request(`/api/v1/analytics/summary${qs ? `?${qs}` : ''}`)
}

export async function fetchTopExpenses(type = 'debit', limit = 10, filters = {}) {
  const params = new URLSearchParams({ type, limit: String(limit) })
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/top-expenses?${params}`)
}

export async function fetchTopExpenseTransactions(type = 'debit', iinBin, account, name, limit = 200, filters = {}) {
  const params = new URLSearchParams({ type, limit: String(limit) })
  if (iinBin) params.set('iin_bin', iinBin)
  if (account) params.set('account', account)
  if (name) params.set('name', name)
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/top-expenses-transactions?${params}`)
}

export async function fetchTopCounterparties(limit = 10, filters = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/top-counterparties?${params}`)
}

export async function fetchCounterpartySearch(query, limit = 8) {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  })
  return request(`/api/v1/analytics/counterparty-search?${params}`)
}

export async function fetchCategorySummary(limit = 24, filters = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/category-summary?${params}`)
}

export async function fetchComparePeriods({
  dateFromA,
  dateToA,
  dateFromB,
  dateToB,
  limit = 20,
  filters = {},
}) {
  const params = new URLSearchParams({
    date_from_a: dateFromA,
    date_to_a: dateToA,
    date_from_b: dateFromB,
    date_to_b: dateToB,
    limit: String(limit),
  })
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/compare-periods?${params}`, {}, 120000)
}

export async function fetchCashTop(type = 'withdrawal', limit = 10, filters = {}) {
  const params = new URLSearchParams({ type, limit: String(limit) })
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/cash-top?${params}`)
}

export async function fetchCashTransactions(type = 'withdrawal', iinBin, account, limit = 100, filters = {}) {
  const params = new URLSearchParams({ type, iin_bin: iinBin, limit: String(limit) })
  if (account) params.set('account', account)
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/cash-transactions?${params}`)
}

export async function fetchCounterpartyTransactions(iinBin, account, limit = 200, filters = {}) {
  const params = new URLSearchParams({ iin_bin: iinBin, limit: String(limit) })
  if (account) params.set('account', account)
  appendSharedFilters(params, filters)
  return request(`/api/v1/analytics/counterparty-transactions?${params}`)
}

export async function fetchCounterpartyGraph(iinBin, depth = 2, maxNeighbors = 6) {
  const params = new URLSearchParams({
    iin_bin: iinBin,
    depth: String(depth),
    max_neighbors: String(maxNeighbors),
  })
  return request(`/api/v1/analytics/counterparty-graph?${params}`, {}, 180000)
}

export async function fetchEdgeTransactions(sourceIinBin, targetIinBin, limit = 200) {
  const params = new URLSearchParams({
    source_iin_bin: sourceIinBin,
    target_iin_bin: targetIinBin,
    limit: String(limit),
  })
  return request(`/api/v1/analytics/edge-transactions?${params}`, {}, 120000)
}


