import { createClient } from '@supabase/supabase-js'

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Supabase auth is not configured on server' })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const token = authHeader.slice(7)

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    req.user = user
    return next()
  } catch (err) {
    console.error('[Auth] Failed to validate token:', err)
    return res.status(401).json({ error: 'Auth check failed' })
  }
}
