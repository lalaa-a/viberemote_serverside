import jwt from 'jsonwebtoken'

// gen-keys.js — run with: node gen-keys.js
//const jwt = require('jsonwebtoken')

const JWT_SECRET = 'Wu2NA+AZUaWvbbAu2bTEqfGDih6xZhBRpNI+7sfOz75fqC7ks5ZvZQ=='

const anonKey = jwt.sign(
  { role: 'anon', iss: 'supabase', iat: 1741910400, exp: 1899676800 },
  JWT_SECRET
)

const serviceKey = jwt.sign(
  { role: 'service_role', iss: 'supabase', iat: 1741910400, exp: 1899676800 },
  JWT_SECRET
)


//expire date is in 2030

console.log('ANON_KEY=', anonKey)
console.log('SERVICE_ROLE_KEY=', serviceKey)



//ANON_KEY= eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzQxOTEwNDAwLCJleHAiOjE4OTk2NzY4MDB9.cfD9K8AVYXFkQYeG0ZKIYiWwYOmuzfSXBR-DCBazEZ0
//SERVICE_ROLE_KEY= eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NDE5MTA0MDAsImV4cCI6MTg5OTY3NjgwMH0.zzv2VtnWgEKjQ2ZH77hBsao4vykoSkDCdvUkyBoReLw