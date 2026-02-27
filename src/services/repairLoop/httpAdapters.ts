import type {
  RepairAgentAdapter,
  RepairAgentRequest,
  RepairAgentResponse,
  SandboxAdapter,
  SandboxApplyRequest,
  SandboxApplyResponse,
  TestRunnerAdapter,
  TestRunnerRequest,
  TestRunnerResponse,
} from './types'
import {
  fromRepairAgentContractResponse,
  toRepairAgentContractRequest,
} from './repairAgentContract'

type EndpointConfig = {
  repairAgent: string
  sandbox: string
  testRunner: string
}

type HttpAdaptersConfig = {
  baseUrl?: string
  endpoints?: Partial<EndpointConfig>
  headers?: HeadersInit | (() => HeadersInit)
}

const DEFAULT_ENDPOINTS: EndpointConfig = {
  repairAgent: '/api/repair-agent/propose',
  sandbox: '/api/sandbox/apply-patch',
  testRunner: '/api/tests/run',
}

const resolveHeaders = (headers: HttpAdaptersConfig['headers']) =>
  typeof headers === 'function' ? headers() : headers

const postJson = async <TRequest, TResponse>(
  url: string,
  payload: TRequest,
  signal?: AbortSignal,
  headers?: HeadersInit
) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const data = (await response.json()) as { message?: string; error?: string }
      message = data.message ?? data.error ?? message
    } catch {
      // no-op
    }
    throw new Error(message)
  }

  return (await response.json()) as TResponse
}

const buildUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`

type AdapterPayload<T> = Omit<T, 'signal'>

export const createRepairLoopHttpAdapters = ({
  baseUrl = '',
  endpoints = {},
  headers,
}: HttpAdaptersConfig = {}): {
  repairAgent: RepairAgentAdapter
  sandbox: SandboxAdapter
  testRunner: TestRunnerAdapter
} => {
  const resolved: EndpointConfig = {
    ...DEFAULT_ENDPOINTS,
    ...endpoints,
  }

  const requestHeaders = resolveHeaders(headers)

  const repairAgent: RepairAgentAdapter = {
    async proposePatch(input: RepairAgentRequest): Promise<RepairAgentResponse> {
      const { signal, ...payload } = input
      const contractRequest = toRepairAgentContractRequest(payload)
      const raw = await postJson<typeof contractRequest, unknown>(
        buildUrl(baseUrl, resolved.repairAgent),
        contractRequest,
        signal,
        requestHeaders
      )
      return fromRepairAgentContractResponse(raw)
    },
  }

  const sandbox: SandboxAdapter = {
    applyPatch(input: SandboxApplyRequest) {
      const { signal, ...payload } = input
      return postJson<AdapterPayload<SandboxApplyRequest>, SandboxApplyResponse>(
        buildUrl(baseUrl, resolved.sandbox),
        payload,
        signal,
        requestHeaders
      )
    },
  }

  const testRunner: TestRunnerAdapter = {
    runTests(input: TestRunnerRequest) {
      const { signal, ...payload } = input
      return postJson<AdapterPayload<TestRunnerRequest>, TestRunnerResponse>(
        buildUrl(baseUrl, resolved.testRunner),
        payload,
        signal,
        requestHeaders
      )
    },
  }

  return { repairAgent, sandbox, testRunner }
}
