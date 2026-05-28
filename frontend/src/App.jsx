import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Archive, Network, ShieldCheck, Activity, Users, List, ChevronUp, ChevronDown, FileDown } from 'lucide-react'
import './App.css'
import Navbar from './components/Navbar'
import Sidebar from './components/Sidebar'
import DataTable from './components/DataTable'
import AnalyticsDashboard from './components/AnalyticsDashboard'
import NetworkGraph from './components/NetworkGraph'
import Login from './components/Login'
import ProjectManagerModal from './components/ProjectManagerModal'
import HistoryModal from './components/HistoryModal'
import UploadTracker from './components/UploadTracker'
import {
  AUTH_EXPIRED_EVENT,
  activateProject,
  fetchEsfRecords,
  fetchEsfSummarySheet,
  fetchEsfTruSummarySheet,
  fetchProjects,
  fetchTransactions,
  logout as apiLogout,
  importStatement,
  createProject as apiCreateProject,
  deleteProject as apiDeleteProject,
  exportEsfExcel,
  exportTransactionsExcel,
} from './services/api'

const IMPORT_REVIEWS_STORAGE_KEY = 'finanalytica:import-reviews'

function getWarningKey(warning = {}) {
  return JSON.stringify([
    warning?.code || '',
    warning?.title || '',
    warning?.summary || '',
    warning?.articles || [],
    warning?.indicators || [],
    warning?.counterparties || [],
    warning?.sample_transactions || [],
  ])
}

function mergeImportWarnings(incomingWarnings = [], existingWarnings = []) {
  const existingStateByKey = new Map(
    existingWarnings.map((warning) => [getWarningKey(warning), {
      archived: warning.archived,
      resolution: warning.resolution,
      uid: warning.uid,
    }])
  )
  const mergedWarnings = [...incomingWarnings, ...existingWarnings]
  return mergedWarnings.filter((warning, index, all) => {
    const key = getWarningKey(warning)
    const firstIdx = all.findIndex((candidate) => getWarningKey(candidate) === key)
    if (index === firstIdx) {
      const existingState = existingStateByKey.get(key)
      if (existingState) {
        warning.archived = existingState.archived
        warning.resolution = existingState.resolution
        warning.uid = existingState.uid || warning.uid
      }
      if (!warning.uid) {
        warning.uid = `w-${Math.random().toString(36).substr(2, 9)}`
      }
    }
    return index === firstIdx
  })
}

// Helper function to extract user role from token
function getRoleFromToken() {
  try {
    const token = localStorage.getItem('token')
    if (!token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const payload = JSON.parse(atob(normalized))
    return payload.role || null
  } catch {
    return null
  }
}

function isCompleteFilterDate(value) {
  return /^\d{2}\.\d{2}\.\d{4}$/.test(String(value || '').trim())
}

function mapEsfRecordToTableRow(record, viewDirection = 'sale') {
  const amount = Number(record?.total_amount || 0)
  const isPurchase = viewDirection === 'purchase'
  const category = isPurchase ? 'Приобретение' : 'Реализация'
  const purpose = [record?.tru_name, record?.registration_number, record?.contract_number]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n')

  return {
    id: record?.id,
    date: record?.turnover_date || record?.issue_date || '',
    sender: {
      name: record?.supplier?.name || '',
      iin_bin: record?.supplier?.iin_bin || '',
      account: '',
    },
    recipient: {
      name: record?.buyer?.name || '',
      iin_bin: record?.buyer?.iin_bin || '',
      account: '',
    },
    category,
    transaction_category: category,
    operation_type: `ЭСФ ${String(record?.esf_status || '').trim()}`.trim(),
    purpose,
    currency: record?.currency_code || 'KZT',
    debit: isPurchase ? amount : 0,
    credit: isPurchase ? 0 : amount,
    amount_tenge: amount,
    buyer_iin_bin: record?.buyer?.iin_bin || '',
    buyer_name: record?.buyer?.name || '',
    supplier_iin_bin: record?.supplier?.iin_bin || '',
    supplier_name: record?.supplier?.name || '',
    tru_name: record?.tru_name || '',
    price_with_vat: Number(record?.price_with_vat || 0),
    price_without_vat: Number(record?.price_without_vat || 0),
    vat_rate: Number(record?.vat_rate || 0),
    unit: record?.unit || '',
    quantity: Number(record?.quantity || 0),
    uploaded_by_email: '',
  }
}

function App() {
  const uploadInputRef = useRef(null)
  const uploadParserTypeRef = useRef('smart_parser')
  const [theme, setTheme] = useState('dark')
  const [activeTab, setActiveTab] = useState('transactions')
  const [uploadParserType, setUploadParserType] = useState('smart_parser')
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false)
  const [importReviewsByProject, setImportReviewsByProject] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(IMPORT_REVIEWS_STORAGE_KEY) || '{}')
    } catch {
      return {}
    }
  })
  const [importReviewOpen, setImportReviewOpen] = useState(false)
  const [expandedImportWarningCode, setExpandedImportWarningCode] = useState(null)
  const [networkFocusTarget, setNetworkFocusTarget] = useState(null)
  const [visitedTabs, setVisitedTabs] = useState({
    analytics: false,
    comparison: false,
    chat: false,
    network: false,
  })
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('user') || 'null')
    } catch {
      return null
    }
  })
  const [projects, setProjects] = useState([])
  const [projectManagerOpen, setProjectManagerOpen] = useState(false)
  const [historyModalOpen, setHistoryModalOpen] = useState(false)

  // Upload Tracking State
  const [uploadQueue, setUploadQueue] = useState([])
  const uploadQueueRef = useRef([]) // To track changes for the long-running loop
  const [showUploadTracker, setShowUploadTracker] = useState(false)
  const [isTrackerMinimized, setIsTrackerMinimized] = useState(false)

  // Sync ref with state whenever it changes
  useEffect(() => {
    uploadQueueRef.current = uploadQueue
  }, [uploadQueue])

  const handleCancelUpload = (index) => {
    setUploadQueue(prev => prev.map((item, idx) => 
      idx === index ? { ...item, status: 'cancelled', message: 'Отменено пользователем' } : item
    ))
  }

  const [filters, setFilters] = useState({
    date: '',
    category: '',
    search: '',
    minAmount: '',
    maxAmount: '',
    currency: '',
    sender: '',
    recipient: '',
  })
  const [recordsMode, setRecordsMode] = useState('all')
  const [esfDirection, setEsfDirection] = useState('sale')
  const [esfSheet, setEsfSheet] = useState('esf')
  const [esfYears, setEsfYears] = useState([])
  const [transactions, setTransactions] = useState([])
  const [pagination, setPagination] = useState({
    page: 1,
    per_page: 50,
    total: 0,
    total_pages: 0,
  })
  const [summary, setSummary] = useState({ total_debit: 0, total_credit: 0 })
  const [txLoading, setTxLoading] = useState(false)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [exportLoading, setExportLoading] = useState(false)
  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' })
  const activeProjectId = user?.active_project_id || null
  const projectImportReview = activeProjectId ? importReviewsByProject[activeProjectId] || { warnings: [] } : { warnings: [] }
  
  const activeWarnings = (projectImportReview.warnings || []).filter(w => !w.archived)
  const archivedWarnings = (projectImportReview.warnings || []).filter(w => w.archived)
  
  const currentImportReview = {
    ...projectImportReview,
    warnings: activeWarnings
  }

  const handleArchiveWarning = (uid) => {
    if (!activeProjectId) return
    setImportReviewsByProject(prev => {
      const projectData = prev[activeProjectId]
      if (!projectData) return prev
      return {
        ...prev,
        [activeProjectId]: {
          ...projectData,
          warnings: projectData.warnings.map(w => 
            (w.uid === uid || w.code === uid) ? { ...w, archived: true, resolution: 'rejected' } : w
          )
        }
      }
    })
  }

  const handleApproveWarning = (uid) => {
    if (!activeProjectId) return
    setImportReviewsByProject(prev => {
      const projectData = prev[activeProjectId]
      if (!projectData) return prev
      return {
        ...prev,
        [activeProjectId]: {
          ...projectData,
          warnings: projectData.warnings.map(w => 
            (w.uid === uid || w.code === uid) ? { ...w, archived: true, resolution: 'accepted' } : w
          )
        }
      }
    })
  }

  const handleUnarchiveWarning = (uid) => {
    if (!activeProjectId) return
    setImportReviewsByProject(prev => {
      const projectData = prev[activeProjectId]
      if (!projectData) return prev
      return {
        ...prev,
        [activeProjectId]: {
          ...projectData,
          warnings: projectData.warnings.map(w => 
            (w.uid === uid || w.code === uid) ? { ...w, archived: false, resolution: undefined } : w
          )
        }
      }
    })
  }

  const syncStoredUser = useCallback((nextUser) => {
    setUser(nextUser)
    if (nextUser) {
      localStorage.setItem('user', JSON.stringify(nextUser))
    } else {
      localStorage.removeItem('user')
    }
  }, [])

  const loadTransactions = useCallback(async (f = filters, page = 1, sort = sortConfig) => {
    if (!user) return
    setTxLoading(true)
    try {
      const normalizedDate = String(f?.date || '').trim()
      const apiDate = isCompleteFilterDate(normalizedDate) ? normalizedDate : ''
      const requestFilters = {
        ...f,
        date: apiDate,
        sortBy: sort.key,
        sortDir: sort.direction,
        page,
        perPage: 50,
      }

      if (recordsMode === 'esf') {
        const esfFilters = {
          ...requestFilters,
          direction: esfDirection,
        }
        if (esfSheet === 'summary') {
          const res = await fetchEsfSummarySheet(esfFilters)
          setTransactions(res.data || [])
          setPagination(res.pagination)
          setEsfYears(res.years || [])
          setSummary({
            total_debit: esfDirection === 'purchase' ? Number(res.summary?.total_amount || 0) : 0,
            total_credit: esfDirection === 'sale' ? Number(res.summary?.total_amount || 0) : 0,
          })
        } else if (esfSheet === 'tru') {
          const res = await fetchEsfTruSummarySheet(esfFilters)
          setTransactions(res.data || [])
          setPagination(res.pagination)
          setEsfYears(res.years || [])
          setSummary({
            total_debit: esfDirection === 'purchase' ? Number(res.summary?.total_amount || 0) : 0,
            total_credit: esfDirection === 'sale' ? Number(res.summary?.total_amount || 0) : 0,
          })
        } else {
          const res = await fetchEsfRecords(esfFilters)
          setTransactions((res.data || []).map((record) => mapEsfRecordToTableRow(record, esfDirection)))
          setPagination(res.pagination)
          setEsfYears([])
          setSummary({
            total_debit: esfDirection === 'purchase' ? Number(res.summary?.total_amount || 0) : 0,
            total_credit: esfDirection === 'sale' ? Number(res.summary?.total_amount || 0) : 0,
          })
        }
      } else {
        const res = await fetchTransactions({
          ...requestFilters,
          scope: recordsMode === 'all' ? 'all' : 'bank',
        })
        setTransactions(res.data || [])
        setPagination(res.pagination)
        setEsfYears([])
        setSummary(res.summary)
      }
    } catch (err) {
      console.error('Failed to load transactions:', err)
      setTransactions([])
      setPagination({ page: 1, per_page: 50, total: 0, total_pages: 0 })
      setSummary({ total_debit: 0, total_credit: 0 })
    } finally {
      setTxLoading(false)
    }
  }, [esfDirection, esfSheet, filters, recordsMode, sortConfig, user])

  useEffect(() => {
    if (user) loadTransactions(filters, 1, sortConfig)
  }, [filters, user, loadTransactions, sortConfig, activeProjectId, recordsMode, esfDirection, esfSheet])

  const loadImportWarnings = useCallback(() => {}, [])

  useEffect(() => {
    if (user && activeProjectId) {
      loadImportWarnings()
    }
  }, [user, activeProjectId, loadImportWarnings])

  useEffect(() => {
    let cancelled = false

    if (!user) {
      setProjects([])
      return undefined
    }

    ;(async () => {
      try {
        const res = await fetchProjects()
        if (cancelled) return
        setProjects(res.items || [])
        if (res.active_project_id && res.active_project_id !== user.active_project_id) {
          syncStoredUser({ ...user, active_project_id: res.active_project_id })
        }
      } catch (err) {
        console.error('Failed to load projects:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [user, syncStoredUser])

  useEffect(() => {
    function handleAuthExpired() {
      syncStoredUser(null)
      setProjects([])
      setImportReviewsByProject({})
      localStorage.removeItem(IMPORT_REVIEWS_STORAGE_KEY)
      setImportReviewOpen(false)
      setExpandedImportWarningCode(null)
      setProjectManagerOpen(false)
      setNetworkFocusTarget(null)
      setActiveTab('transactions')
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(IMPORT_REVIEWS_STORAGE_KEY, JSON.stringify(importReviewsByProject))
    } catch {
      // ignore storage write failures
    }
  }, [importReviewsByProject])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.className = theme
  }, [theme])

  useEffect(() => {
    if (activeTab === 'analytics') {
      setVisitedTabs((prev) => (prev.analytics ? prev : { ...prev, analytics: true }))
    }
    if (activeTab === 'comparison') {
      setVisitedTabs((prev) => (prev.comparison ? prev : { ...prev, comparison: true }))
    }
    if (activeTab === 'chat') {
      setVisitedTabs((prev) => (prev.chat ? prev : { ...prev, chat: true }))
    }
    if (activeTab === 'network') {
      setVisitedTabs((prev) => (prev.network ? prev : { ...prev, network: true }))
    }
  }, [activeTab])

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  const handleAuthSuccess = (authUser) => {
    syncStoredUser(authUser)
  }

  const handleLogout = async () => {
    try {
      await apiLogout()
    } catch (err) {
      console.warn('Logout request failed:', err)
    } finally {
      localStorage.removeItem('token')
      syncStoredUser(null)
      setProjects([])
      setImportReviewsByProject({})
      localStorage.removeItem(IMPORT_REVIEWS_STORAGE_KEY)
      setImportReviewOpen(false)
      setExpandedImportWarningCode(null)
      setProjectManagerOpen(false)
      setNetworkFocusTarget(null)
      setActiveTab('transactions')
    }
  }

  const applyProjectState = useCallback((payload) => {
    setProjects(payload.items || [])
    const nextProjectId = payload.active_project_id || null
    if (user && nextProjectId !== user.active_project_id) {
      syncStoredUser({ ...user, active_project_id: nextProjectId })
    }
    setVisitedTabs({ analytics: false, comparison: false, chat: false, network: false })
    setImportReviewOpen(false)
    setExpandedImportWarningCode(null)
    setNetworkFocusTarget(null)
    setActiveTab('transactions')
    return nextProjectId
  }, [syncStoredUser, user])

  const handleProjectChange = async (projectId) => {
    if (!projectId || projectId === activeProjectId) return
    try {
      const payload = await activateProject(projectId)
      applyProjectState(payload)
      await loadTransactions(filters, 1, sortConfig)
    } catch (err) {
      throw new Error(err.message || 'Не удалось переключить проект')
    }
  }

  const handleCreateProject = async (name) => {
    const normalized = String(name || '').trim()
    if (!normalized) {
      throw new Error('Введите название проекта')
    }
    try {
      const payload = await apiCreateProject(normalized)
      applyProjectState(payload)
      await loadTransactions(filters, 1, sortConfig)
      return payload
    } catch (err) {
      throw new Error(err.message || 'Не удалось создать проект')
    }
  }

  const handleDeleteProject = async (projectId) => {
    if (!projectId) {
      throw new Error('Проект не найден')
    }
    try {
      const payload = await apiDeleteProject(projectId)
      applyProjectState(payload)
      await loadTransactions(filters, 1, sortConfig)
      return payload
    } catch (err) {
      throw new Error(err.message || 'Не удалось удалить проект')
    }
  }

  const isAdmin = (user?.role || getRoleFromToken()) === 'admin'

  const handleExportTransactions = async () => {
    try {
      setExportLoading(true)
      const normalizedDate = String(filters?.date || '').trim()
      const apiDate = isCompleteFilterDate(normalizedDate) ? normalizedDate : ''
      const exportFilters = { ...filters, date: apiDate }
      const blob = recordsMode === 'esf'
        ? await exportEsfExcel(exportFilters)
        : await exportTransactionsExcel({
            ...exportFilters,
            scope: recordsMode === 'all' ? 'all' : 'bank',
          })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      a.href = url
      const exportPrefix = recordsMode === 'esf'
        ? 'esf'
        : recordsMode === 'all'
          ? 'transactions_combined'
          : 'transactions_bank'
      a.download = `${exportPrefix}_${ts}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      window.alert(`Ошибка экспорта: ${err.message}`)
    } finally {
      setExportLoading(false)
    }
  }

  const handleSortChange = (key, direction) => {
    setSortConfig({ key, direction })
  }

  const handleUploadClick = () => {
    if (uploadLoading) return
    setUploadPickerOpen(true)
  }

  const handleUploadParserPick = (parserType) => {
    uploadParserTypeRef.current = parserType
    setUploadParserType(parserType)
    setUploadPickerOpen(false)
    uploadInputRef.current?.click()
  }

  const closeImportReview = () => {
    setImportReviewOpen(false)
  }

  const openCounterpartyGraph = (counterparty) => {
    const iinBin = String(counterparty?.graph_iin_bin || '').trim()
    if (!iinBin) return

    setNetworkFocusTarget({
      iinBin,
      name: counterparty?.name || counterparty?.identifier || iinBin,
      requestId: Date.now(),
    })
    setImportReviewOpen(false)
    setActiveTab('network')
  }

  const getImportWarningSeverityLabel = (severity) => {
    if (severity === 'high') return '\u0412\u044b\u0441\u043e\u043a\u0438\u0439 \u0440\u0438\u0441\u043a'
    if (severity === 'medium') return '\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0440\u0438\u0441\u043a'
    return '\u041d\u0443\u0436\u043d\u0430 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430'
  }

  const getImportWarningSeverityClasses = (severity) => {
    if (severity === 'high') {
      return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
    }
    if (severity === 'medium') {
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
    }
    return 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200'
  }

  const HandleUploadFileChange = async (event) => {
    const selectedFile = event.target.files?.[0]
    event.target.value = ''

    if (!selectedFile) return

    const lower = selectedFile.name.toLowerCase()
    const isSpreadsheet = lower.endsWith('.xls') || lower.endsWith('.xlsx')

    if (!isSpreadsheet) {
      window.alert('Поддерживаются только .xls и .xlsx')
      return
    }

    try {
      setUploadLoading(true)
      const result = await importStatement(selectedFile, 'smart_parser')
      window.alert(`Импорт завершен: ${result.inserted} добавлено`)
      if ((uploadParserTypeRef.current || uploadParserType) === 'esf') {
        setRecordsMode('esf')
      }
      await loadTransactions(filters, 1, sortConfig)
      setActiveTab('transactions')
      const details = []
      if (result.duplicates) details.push(`дубликаты: ${result.duplicates}`)
      if (result.unreadable) details.push(`непрочитано: ${result.unreadable}`)
      if (result.invalid) details.push(`невалидные строки: ${result.invalid}`)
      const detailText = details.length ? `\nПричины пропуска: ${details.join(', ')}` : ''
      window.alert(`Импорт завершен: ${result.inserted} добавлено, ${result.skipped} пропущено${detailText}`)
      await loadTransactions(filters, 1, sortConfig)
      setActiveTab('transactions')
    } catch (err) {
      window.alert(`Ошибка импорта: ${err.message}`)
    } finally {
      setUploadLoading(false)
    }
  }

  const HandleUploadFileChangeClean = async (event) => {
    const selectedFile = event.target.files?.[0]
    event.target.value = ''

    if (!selectedFile) return

    const lower = selectedFile.name.toLowerCase()
    const isSpreadsheet = lower.endsWith('.xls') || lower.endsWith('.xlsx')

    if (!isSpreadsheet) {
      window.alert('\u041f\u043e\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u044e\u0442\u0441\u044f \u0442\u043e\u043b\u044c\u043a\u043e .xls \u0438 .xlsx')
      return
    }

    try {
      setUploadLoading(true)
      const result = await importStatement(selectedFile, 'smart_parser')
      await loadTransactions(filters, 1, sortConfig)
      setActiveTab('transactions')
      const warnings = []
      if (warnings.length > 0) {
        const projectKey = activeProjectId || 'default-project'
        let firstWarningCode = warnings[0]?.code || null

        setImportReviewsByProject((prev) => {
          const existing = prev[projectKey]
          const existingWarnings = Array.isArray(existing?.warnings) ? existing.warnings : []
          const dedupedWarnings = mergeImportWarnings(warnings, existingWarnings)

          firstWarningCode = dedupedWarnings[0]?.code || firstWarningCode

          return {
            ...prev,
            [projectKey]: {
              inserted: (existing?.inserted || 0) + (result.inserted ?? 0),
              skipped: (existing?.skipped || 0) + (result.skipped ?? 0),
              warnings: dedupedWarnings,
            },
          }
        })
        setExpandedImportWarningCode(firstWarningCode)
        setImportReviewOpen(false)
        window.alert(`Импорт завершен: ${result.inserted} добавлено`)
      } else {
        setImportReviewOpen(false)
        setExpandedImportWarningCode(null)
        window.alert(`\u0418\u043c\u043f\u043e\u0440\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d: ${result.inserted} \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e`)
      }
    } catch (err) {
      window.alert(`\u041e\u0448\u0438\u0431\u043a\u0430 \u0438\u043c\u043f\u043e\u0440\u0442\u0430: ${err.message}`)
    } finally {
      setUploadLoading(false)
    }
  }

  const handleMultiUploadFileChange = async (event) => {
    const selectedFiles = Array.from(event.target.files || [])
    event.target.value = ''
    const activeUploadParserType = uploadParserTypeRef.current || uploadParserType

    if (!selectedFiles.length) return

    const invalidFiles = selectedFiles.filter((file) => {
      const lower = file.name.toLowerCase()
      if (activeUploadParserType === 'esf') {
        return !(lower.endsWith('.csv') || lower.endsWith('.xls') || lower.endsWith('.xlsx'))
      }
      return !(lower.endsWith('.xls') || lower.endsWith('.xlsx'))
    })

    if (invalidFiles.length > 0) {
      if (activeUploadParserType === 'esf') {
        window.alert('Поддерживаются .csv, .xls и .xlsx для ЭСФ')
      } else {
        window.alert('Поддерживаются только .xls и .xlsx')
      }
      return
    }

    const initialQueue = selectedFiles.map(file => ({
      name: file.name,
      status: 'pending',
      message: ''
    }))

    setUploadQueue(initialQueue)
    uploadQueueRef.current = initialQueue
    setShowUploadTracker(true)
    setIsTrackerMinimized(false)

    try {
      setUploadLoading(true)
      let totalInserted = 0
      let totalSkipped = 0
      const allWarnings = []

      for (let i = 0; i < selectedFiles.length; i++) {
        // Check if this task was cancelled while we were processing previous ones
        if (uploadQueueRef.current[i].status === 'cancelled') continue

        const file = selectedFiles[i]
        
        // Update status to processing
        setUploadQueue(prev => prev.map((item, idx) => 
          idx === i ? { ...item, status: 'processing', message: 'Анализ документа...' } : item
        ))

        try {
          const result = await importStatement(file, activeUploadParserType)
          
          const inserted = result?.inserted ?? 0
          const skipped = result?.skipped ?? 0
          totalInserted += inserted
          totalSkipped += skipped

          // Update status to done with stats
          setUploadQueue(prev => prev.map((item, idx) => 
            idx === i ? { 
              ...item, 
              status: 'done', 
              message: `Готово`,
              stats: { inserted, skipped }
            } : item
          ))
        } catch (err) {
          // Update status to error
          setUploadQueue(prev => prev.map((item, idx) => 
            idx === i ? { ...item, status: 'error', message: err.message } : item
          ))
        }
      }

      await loadTransactions(filters, 1, sortConfig)
      setActiveTab('transactions')

      if (allWarnings.length > 0) {
        const projectKey = activeProjectId || 'default-project'
        let firstWarningCode = allWarnings[0]?.uid || allWarnings[0]?.code || null

        setImportReviewsByProject((prev) => {
          const existing = prev[projectKey]
          const existingWarnings = Array.isArray(existing?.warnings) ? existing.warnings : []
          const dedupedWarnings = mergeImportWarnings(allWarnings, existingWarnings)

          firstWarningCode = dedupedWarnings[0]?.code || firstWarningCode

          return {
            ...prev,
            [projectKey]: {
              inserted: (existing?.inserted || 0) + totalInserted,
              skipped: (existing?.skipped || 0) + totalSkipped,
              warnings: dedupedWarnings,
            },
          }
        })

        setExpandedImportWarningCode(firstWarningCode)
        setImportReviewOpen(false)
      } else {
        setImportReviewOpen(false)
        setExpandedImportWarningCode(null)
      }
    } catch (err) {
      setUploadQueue(prev => prev.map(item => 
        item.status === 'processing' || item.status === 'pending' 
          ? { ...item, status: 'error', message: err.message } 
          : item
      ))
    } finally {
      setUploadLoading(false)
    }
  }

  if (!user) {
    return <Login onAuthSuccess={handleAuthSuccess} theme={theme} />
  }

  const tabs = [
    { id: 'transactions', label: 'Транзакции' },
    { id: 'analytics', label: 'Аналитика' },
    { id: 'comparison', label: 'Справка' },
    { id: 'network', label: 'Network' },
    ...(isAdmin ? [{ id: 'chat', label: 'Ассистент' }] : []),
  ]
  const isBlankTab = activeTab === 'comparison' || activeTab === 'chat'

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-[#09090B] text-slate-700 dark:text-zinc-400 font-sans transition-colors">
      <input
        ref={uploadInputRef}
        type="file"
        accept=".xls,.xlsx,.csv"
        multiple
        onChange={handleMultiUploadFileChange}
        className="hidden"
      />

      {uploadPickerOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-white/95 p-6 shadow-2xl shadow-slate-950/30 dark:bg-[#101014]/95">
            <p className="text-[11px] font-bold uppercase tracking-[0.35em] text-slate-400 dark:text-zinc-500">
              Upload
            </p>
            <h3 className="mt-2 text-2xl font-black text-slate-900 dark:text-white">
              Выберите банк
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-zinc-400">
              Сначала выберите тип выписки, потом откроется окно выбора файла.
            </p>

            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleUploadParserPick('kaspi')}
                className="rounded-2xl border border-cyan-300/60 bg-cyan-50 px-4 py-4 text-left transition-all duration-300 hover:scale-[1.02] hover:bg-cyan-100 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:hover:bg-cyan-500/15"
              >
                <div className="text-sm font-black uppercase tracking-[0.22em] text-cyan-700 dark:text-cyan-300">
                  Kaspi
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                  Выписка Kaspi Bank
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleUploadParserPick('halyk_parser')}
                className="rounded-2xl border border-violet-300/60 bg-violet-50 px-4 py-4 text-left transition-all duration-300 hover:scale-[1.02] hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/10 dark:hover:bg-violet-500/15"
              >
                <div className="text-sm font-black uppercase tracking-[0.22em] text-violet-700 dark:text-violet-300">
                  Halyk
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                  Выписка Halyk Bank
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleUploadParserPick('esf')}
                className="rounded-2xl border border-amber-300/60 bg-amber-50 px-4 py-4 text-left transition-all duration-300 hover:scale-[1.02] hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:hover:bg-amber-500/15"
              >
                <div className="text-sm font-black uppercase tracking-[0.22em] text-amber-700 dark:text-amber-300">
                  ESF
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                  ЭСФ: CSV, XLS или XLSX
                </div>
              </button>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setUploadPickerOpen(false)
                }}
                className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 dark:border-[#27272f] dark:text-zinc-300 dark:hover:bg-[#17171d]"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {importReviewOpen && currentImportReview && (
        <div 
          onClick={closeImportReview}
          className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/60 px-4 py-6 backdrop-blur-md cursor-pointer"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="flex h-full max-h-[85vh] w-full max-w-6xl overflow-hidden rounded-[32px] border border-white/10 bg-white/95 shadow-2xl shadow-slate-950/30 dark:bg-[#101014]/95 cursor-default"
          >
            
            {/* Sidebar (List of Risks) */}
            <div className="flex w-[320px] flex-col border-r border-slate-100 bg-slate-50/50 dark:border-white/5 dark:bg-white/[0.02]">
              <div className="border-b border-slate-100 p-5 dark:border-white/5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-rose-500 dark:text-rose-400">
                      Проверка риска
                    </p>
                    <h3 className="mt-1 text-lg font-black text-slate-900 dark:text-white">
                      Отчеты
                    </h3>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        const idx = currentImportReview.warnings.findIndex(w => (w.uid || w.code) === (expandedImportWarningCode))
                        if (idx > 0) setExpandedImportWarningCode(currentImportReview.warnings[idx - 1].uid || currentImportReview.warnings[idx - 1].code)
                      }}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-white hover:text-slate-900 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white"
                      title="Предыдущий"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        const idx = currentImportReview.warnings.findIndex(w => (w.uid || w.code) === (expandedImportWarningCode))
                        if (idx >= 0 && idx < currentImportReview.warnings.length - 1) {
                          setExpandedImportWarningCode(currentImportReview.warnings[idx + 1].uid || currentImportReview.warnings[idx + 1].code)
                        }
                      }}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-white hover:text-slate-900 dark:border-white/5 dark:hover:bg-white/10 dark:hover:text-white"
                      title="Следующий"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
                {currentImportReview.warnings.map((warning) => {
                  const isSelected = (warning.uid || warning.code) === expandedImportWarningCode
                  return (
                    <button
                      key={warning.uid || warning.code}
                      onClick={() => setExpandedImportWarningCode(warning.uid || warning.code)}
                      className={`group flex w-full flex-col gap-1.5 rounded-2xl border p-3.5 text-left transition-all duration-200 ${
                        isSelected
                          ? 'border-indigo-500/30 bg-indigo-50/50 shadow-sm dark:border-indigo-500/40 dark:bg-indigo-500/10'
                          : 'border-transparent hover:bg-white dark:hover:bg-white/5'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[8px] font-black uppercase tracking-widest ${getImportWarningSeverityClasses(warning.severity)}`}>
                          {getImportWarningSeverityLabel(warning.severity)}
                        </span>
                        {isSelected && <div className="h-1.5 w-1.5 rounded-full bg-indigo-500" />}
                      </div>
                      <div className={`text-xs font-black transition-colors ${isSelected ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-800 dark:text-zinc-200'}`}>
                        {warning.title}
                      </div>
                      <div className="line-clamp-2 text-[10px] text-slate-400 dark:text-zinc-500">
                        {warning.summary}
                      </div>
                    </button>
                  )
                })}
              </div>

              <div className="border-t border-slate-100 p-4 dark:border-white/5">
                <button
                  type="button"
                  onClick={closeImportReview}
                  className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-zinc-200"
                >
                  Закрыть проверку
                </button>
              </div>
            </div>

            {/* Main Content (Intelligence Dossier) */}
            <div className="flex flex-1 flex-col bg-white dark:bg-[#0C0C0E]">
              {(() => {
                const warning = currentImportReview.warnings.find(w => (w.uid || w.code) === (expandedImportWarningCode))
                if (!warning) {
                  return (
                    <div className="flex h-full flex-col items-center justify-center text-center p-12">
                      <ShieldCheck className="h-12 w-12 text-slate-100 dark:text-white/5 mb-4" />
                      <h4 className="text-sm font-bold text-slate-400">Выберите отчет для анализа деталей</h4>
                    </div>
                  )
                }

                return (
                  <div className="flex h-full flex-col animate-in fade-in slide-in-from-right-2 duration-300">
                    {/* Header */}
                    <div className="flex items-start justify-between border-b border-slate-100 p-6 dark:border-white/5">
                      <div className="max-w-xl">
                        <div className="flex items-center gap-3">
                          <h2 className="text-xl font-black text-slate-900 dark:text-white">{warning.title}</h2>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {Array.isArray(warning.articles) && warning.articles.map(article => (
                            <span key={article} className="rounded-full bg-rose-500/5 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-rose-500 border border-rose-500/10">
                              {article}
                            </span>
                          ))}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {}}
                          disabled
                          className="flex cursor-not-allowed items-center gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-indigo-600 opacity-50 dark:text-indigo-300"
                          title="Word export disabled"
                        >
                          <FileDown className="h-4 w-4" />
                          Word
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApproveWarning(warning.uid || warning.code)}
                          className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-emerald-600 transition-all hover:bg-emerald-500/10 dark:text-emerald-400"
                          title="Снять подозрения"
                        >
                          <ShieldCheck className="h-4 w-4" />
                          Снять подозрения
                        </button>
                        <button
                          type="button"
                          onClick={() => handleArchiveWarning(warning.uid || warning.code)}
                          className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 transition-all hover:bg-slate-50 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/5"
                        >
                          <Archive className="h-4 w-4" />
                          В архив (Риск)
                        </button>
                      </div>
                    </div>

                    {/* Scrollable Intelligence Body */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
                      <section>
                        <div className="mb-4 text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 dark:text-zinc-600">
                          Анализ и заключение
                        </div>
                        <p className="text-sm leading-relaxed text-slate-600 dark:text-zinc-300">
                          {warning.summary}
                        </p>
                      </section>

                      {/* Indicators Grid */}
                      <section>
                        <div className="mb-4 text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 dark:text-zinc-600 flex items-center gap-2">
                          <Activity className="h-3 w-3" /> Признаки риска
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {(warning.indicators || []).map((indicator, index) => (
                            <div key={index} className="rounded-2xl border border-slate-100 bg-slate-50/50 p-4 dark:border-white/5 dark:bg-white/[0.03]">
                              <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-500">
                                {indicator.label}
                              </div>
                              <div className="mt-2 text-base font-black text-slate-900 dark:text-white">
                                {indicator.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>

                      {/* Counterparties */}
                      {Array.isArray(warning.counterparties) && warning.counterparties.length > 0 && (
                        <section>
                          <div className="mb-4 text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 dark:text-zinc-600 flex items-center gap-2">
                            <Users className="h-3 w-3" /> Связанные контрагенты
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {warning.counterparties.map((cp, idx) => {
                              const canOpenGraph = Boolean(cp?.graph_iin_bin)
                              return (
                                <div 
                                  key={idx} 
                                  onClick={() => canOpenGraph && openCounterpartyGraph(cp)}
                                  className={`rounded-2xl border border-slate-100 bg-slate-50/30 p-4 transition-all dark:border-white/5 dark:bg-white/[0.02] ${canOpenGraph ? 'cursor-pointer hover:border-cyan-500/50 hover:bg-cyan-500/5' : ''}`}
                                >
                                  <div className="flex items-start justify-between">
                                    <div>
                                      <div className="text-[9px] font-black uppercase tracking-widest text-indigo-500 mb-1">{cp.role}</div>
                                      <div className="text-sm font-black text-slate-800 dark:text-white">{cp.name}</div>
                                      <div className="text-[10px] text-slate-400 font-mono mt-1">{cp.identifier}</div>
                                    </div>
                                    <div className="text-right">
                                      <div className="text-xs font-black text-slate-800 dark:text-white">{cp.turnover}</div>
                                      <div className="text-[9px] text-slate-400">{cp.transaction_count} операций</div>
                                    </div>
                                  </div>
                                  <div className="mt-3 flex items-center justify-between gap-2">
                                    <div className="flex flex-wrap gap-1.5">
                                      {Array.isArray(cp.articles) && cp.articles.map(a => (
                                        <span key={a} className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-[8px] font-black text-rose-600 uppercase tracking-widest">
                                          {a}
                                        </span>
                                      ))}
                                    </div>
                                    {canOpenGraph && (
                                      <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-cyan-600 dark:text-cyan-400">
                                        <Network className="h-3 w-3" /> Граф
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </section>
                      )}

                      {/* Sample Transactions */}
                      {Array.isArray(warning.sample_transactions) && warning.sample_transactions.length > 0 && (
                        <section>
                          <div className="mb-4 text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 dark:text-zinc-600 flex items-center gap-2">
                            <List className="h-3 w-3" /> Примеры операций
                          </div>
                          <div className="overflow-hidden rounded-2xl border border-slate-100 dark:border-white/5">
                            <table className="w-full text-left">
                              <thead className="bg-slate-50/80 dark:bg-white/5 text-[9px] font-black uppercase tracking-widest text-slate-400">
                                <tr>
                                  <th className="px-4 py-3">Дата</th>
                                  <th className="px-4 py-3">Тип</th>
                                  <th className="px-4 py-3">Сумма</th>
                                  <th className="px-4 py-3">Контрагент</th>
                                  <th className="px-4 py-3">Основание</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100 dark:divide-white/5 text-[11px] text-slate-600 dark:text-zinc-300">
                                {warning.sample_transactions.map((tx, idx) => (
                                  <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors">
                                    <td className="px-4 py-3 whitespace-nowrap">{tx.happened_at}</td>
                                    <td className="px-4 py-3">
                                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[8px] font-black uppercase tracking-widest ${
                                        tx.direction === 'Входящая' 
                                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                          : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                                      }`}>
                                        {tx.direction}
                                      </span>
                                    </td>
                                    <td className="px-4 py-3 font-black text-indigo-500 whitespace-nowrap">{tx.amount}</td>
                                    <td className="px-4 py-3 font-bold text-slate-800 dark:text-zinc-200">{tx.counterparty}</td>
                                    <td className="px-4 py-3 text-[10px] leading-relaxed max-w-sm">{tx.purpose}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      )}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      <Sidebar 
        activeTab={activeTab} 
        onTabChange={setActiveTab} 
        tabs={tabs} 
        onUpload={handleUploadClick}
        uploadLoading={uploadLoading}
        isAdmin={isAdmin}
        onOpenProjects={() => setProjectManagerOpen(true)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {!isBlankTab && (
          <Navbar
            theme={theme}
            toggleTheme={toggleTheme}
            onLogout={handleLogout}
            user={user}
            filters={filters}
            setFilters={setFilters}
          />
        )}

        <ProjectManagerModal
          open={projectManagerOpen}
          theme={theme}
          projects={projects}
          activeProjectId={activeProjectId}
          onClose={() => setProjectManagerOpen(false)}
          onSelectProject={handleProjectChange}
          onCreateProject={handleCreateProject}
          onDeleteProject={handleDeleteProject}
        />

        <HistoryModal
          isOpen={historyModalOpen}
          onClose={() => setHistoryModalOpen(false)}
          projectId={activeProjectId}
          archivedFraud={archivedWarnings}
          onUnarchiveFraud={handleUnarchiveWarning}
        />

        <main className="flex-1 overflow-y-auto custom-scrollbar p-6">
          <div className="max-w-[1400px] mx-auto space-y-6">
            
            {/* View: Transactions */}
            <div className={activeTab === 'transactions' ? 'flex flex-col gap-6' : 'hidden'}>
              <DataTable
                theme={theme}
                isAdmin={isAdmin}
                data={transactions}
                pagination={pagination}
                summary={summary}
                esfDirection={esfDirection}
                esfSheet={esfSheet}
                esfYears={esfYears}
                recordsMode={recordsMode}
                loading={txLoading}
                exportLoading={exportLoading}
                onExport={handleExportTransactions}
                onEsfDirectionChange={setEsfDirection}
                onEsfSheetChange={setEsfSheet}
                onRecordsModeChange={setRecordsMode}
                sortConfig={sortConfig}
                onSortChange={handleSortChange}
                onPageChange={(page) => loadTransactions(filters, page, sortConfig)}
              />
            </div>

            {/* View: Analytics */}
            {(visitedTabs.analytics || activeTab === 'analytics') && (
              <div className={activeTab === 'analytics' ? 'block animate-in fade-in duration-300' : 'hidden'}>
                <AnalyticsDashboard key={activeProjectId || 'default-project'} theme={theme} filters={filters} />
              </div>
            )}

            {(visitedTabs.comparison || activeTab === 'comparison') && (
              <div className={activeTab === 'comparison' ? 'block animate-in fade-in duration-300' : 'hidden'}>
              </div>
            )}

            {(visitedTabs.network || activeTab === 'network') && (
              <div className={activeTab === 'network' ? 'block animate-in fade-in duration-300' : 'hidden'}>
                <NetworkGraph
                  key={activeProjectId || 'default-project'}
                  theme={theme}
                  externalFocus={networkFocusTarget}
                />
              </div>
            )}

            {isAdmin && (visitedTabs.chat || activeTab === 'chat') && (
              <div className={activeTab === 'chat' ? 'block animate-in fade-in duration-300' : 'hidden'}>
              </div>
            )}
          </div>
        </main>

        <UploadTracker 
          tasks={uploadQueue}
          isVisible={showUploadTracker}
          isMinimized={isTrackerMinimized}
          onClose={() => setShowUploadTracker(false)}
          onMinimize={() => setIsTrackerMinimized(!isTrackerMinimized)}
          onCancelTask={handleCancelUpload}
        />
      </div>
    </div>
  )
}

export default App
