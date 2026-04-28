const CORE_API_URL = process.env.CORE_API_URL || 'http://localhost:4000'

async function request(method, path, body) {
  const url = `${CORE_API_URL}${path}`
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }

  if (body !== undefined) {
    options.body = JSON.stringify(body)
  }

  const res = await fetch(url, options)
  const text = await res.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }

  if (!res.ok) {
    const err = new Error(`Core API ${method} ${path} failed (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    err.status = res.status
    err.data = data
    throw err
  }

  return data
}

function netsuiteGet(path) {
  return request('GET', `/api/netsuite${path}`)
}

function netsuitePost(path, body) {
  return request('POST', `/api/netsuite${path}`, body)
}

function netsuitePatch(path, body) {
  return request('PATCH', `/api/netsuite${path}`, body)
}

function suiteQL(query) {
  return netsuitePost('/suiteql', { q: query })
}

function callRestlet(scriptId, deployId, body) {
  return netsuitePost('/restlet', { scriptId, deployId, ...body })
}

function sendStagingNotification(title, message) {
  return request('POST', '/internal/notify/staging', { title, message })
}

module.exports = {
  netsuiteGet,
  netsuitePost,
  netsuitePatch,
  suiteQL,
  callRestlet,
  sendStagingNotification,
}
