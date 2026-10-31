import assert from 'node:assert/strict'
import test from 'node:test'
import { backendTarget, backendApiUrl, workspaceStorageKey, workspaceLink, timelineLink } from '../src/backend-target.ts'

const cloud = 'https://chat.example.workers.dev/'
test('local development stays same-origin; hosted default is the Mac loopback service', () => {
  assert.equal(backendApiUrl('http://127.0.0.1:5173/','/state'),'/api/state')
  assert.equal(backendTarget(cloud).origin,'http://127.0.0.1:4318')
  assert.equal(backendTarget(cloud).hosted,true)
})
test('host selects the same backend for REST and SSE, accepts bare hosts and trailing slash', () => {
  for(const host of ['127.0.0.1:4319','http://127.0.0.1:4319/']) {
    const url=`${cloud}?host=${encodeURIComponent(host)}#/sessions`
    assert.equal(backendApiUrl(url,'/state'),'http://127.0.0.1:4319/api/state')
    assert.equal(backendApiUrl(url,'/events'),'http://127.0.0.1:4319/api/events')
  }
  assert.equal(backendTarget(`${cloud}?host=http://[::1]:4318`).origin,'http://[::1]:4318')
})
test('host rejects credentials, paths, and unsafe schemes', () => {
  for(const host of ['', 'ftp://localhost', 'http://user:secret@localhost', 'http://localhost/api','http://localhost/?token=secret','http://localhost/#foo','localhost:abc','localhost\\@evil.example']) {
    assert.throws(()=>backendTarget(`${cloud}?host=${encodeURIComponent(host)}`),host)
  }
  assert.throws(()=>backendApiUrl(cloud,'//evil.example'))
})
test('host accepts explicit LAN, VPN, and public HTTP(S) backend origins', () => {
  for(const host of ['192.168.1.2:4318','100.64.1.2:4318','https://my-backend.example','http://dev-machine.local:4318']) {
    const url=`${cloud}?host=${encodeURIComponent(host)}`
    assert.equal(backendTarget(url).origin, new URL(host.includes('://')?host:`http://${host}`).origin)
  }
})

test('host-specific drafts never leak across backend origins; existing local keys are retained', () => {
  assert.equal(workspaceStorageKey('http://127.0.0.1:5173/','selected'),'cc:selected')
  assert.notEqual(workspaceStorageKey(`${cloud}?host=localhost:4318`,'draft:new:'),workspaceStorageKey(`${cloud}?host=localhost:4319`,'draft:new:'))
})
test('preview and live links retain host and reset only the preview flag and route', () => {
  const href=`${cloud}?host=localhost:4319#/sessions/abc`
  assert.equal(workspaceLink(href,true),'/?host=localhost%3A4319&preview=oracle')
  assert.equal(workspaceLink(`${cloud}?host=localhost:4319&preview=oracle`,false),'/?host=localhost%3A4319#/new')
})

test('Timeline follows the selected remote backend and stays on that backend origin', () => {
  const href = 'http://workstation.example:4318/sessions?host=http%3A%2F%2Fworkstation.example%3A4318#/sessions/11111111-2222-4333-8444-555555555555'
  const link = new URL(timelineLink(href, new URL(href).hash))
  assert.equal(link.origin, 'http://workstation.example:4318')
  assert.equal(link.pathname, '/api/timeline/view')
  assert.equal(link.search, '')
})

test('Timeline is a route on the backend that serves the chat, for every selected origin', () => {
  const hash = '#/sessions/new?tab=saved&q=hello+world'
  assert.equal(timelineLink(`${cloud}?host=https%3A%2F%2Fbackend.example#/sessions/old`, hash), 'https://backend.example/api/timeline/view')
  assert.equal(timelineLink(`${cloud}#/sessions/old`, hash), 'http://127.0.0.1:4318/api/timeline/view')
})

test('local Timeline is served by the chat backend, never the retired 47881/47882 service', () => {
  const href = 'http://127.0.0.1:4318/#/sessions/local'
  const link = timelineLink(href, '#/sessions/local')
  assert.equal(link, 'http://127.0.0.1:4318/api/timeline/view')
  assert.doesNotMatch(link, /4788[12]/)
})
