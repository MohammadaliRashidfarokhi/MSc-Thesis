import { openaiFetch } from './client'

export type OpenAIFile = {
  id: string
  filename?: string
}

export const uploadFile = async (file: File, signal?: AbortSignal): Promise<OpenAIFile> => {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('purpose', 'user_data')

  const response = await openaiFetch('/files', {
    method: 'POST',
    body: formData,
    signal,
  })

  return (await response.json()) as OpenAIFile
}

export const downloadFileContent = async (fileId: string, signal?: AbortSignal) => {
  const response = await openaiFetch(`/files/${fileId}/content`, {
    method: 'GET',
    signal,
  })
  return response.blob()
}
