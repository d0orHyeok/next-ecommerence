import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import { PrismaAdapter } from '@/server/adapter'
import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import bcrypt from 'bcrypt'
import { encode, decode } from 'next-auth/jwt'
import { setCookie, getCookie } from 'cookies-next'
import { NextApiRequest, NextApiResponse } from 'next'

const SESSION_MAXAGE = 30 * 24 * 60 * 60 // 7 days

const adapter = PrismaAdapter(prisma)
const generate = {
  uuid() {
    return this.uuidv4()
  },
  uuidv4() {
    return (String([1e7]) + -1e3 + -4e3 + -8e3 + -1e11).replace(
      /[018]/g,
      (c: any) =>
        (
          c ^
          (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
        ).toString(16),
    )
  },
}
const generateSessionToken = () => {
  return randomUUID?.() ?? generate.uuid()
}
const fromDate = (time: number, date = Date.now()) => {
  return new Date(date + time * 1000)
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  return NextAuth(req, res, {
    adapter,
    secret: process.env.NEXTAUTH_SECRET,
    session: {
      strategy: 'database',
      maxAge: SESSION_MAXAGE,
      updateAge: 12 * 60 * 60, // 12 hours
    },
    pages: {
      signOut: '/',
      // error: '', // Error code passed in query string as ?error=
      verifyRequest: '/auth/verify-request', // (used for check email message)
      newUser: '/account/welcome', // New users will be directed here on first sign in (leave the property out if not of interest)
    },
    jwt: {
      // Customize the JWT encode and decode functions to overwrite the default behaviour of storing the JWT token in the session  cookie when using credentials providers. Instead we will store the session token reference to the session in the database.
      encode: async ({ token, secret, maxAge }) => {
        if (
          req.query.nextauth?.includes('callback') &&
          req.query.nextauth?.includes('credentials') &&
          req.method === 'POST'
        ) {
          const cookie = getCookie('next-auth.session-token', {
            req,
            res,
          }) as string
          if (cookie) return cookie
          return ''
        }
        // Revert to default behaviour when not in the credentials provider callback flow
        return encode({ token, secret, maxAge })
      },
      decode: async ({ token, secret }) => {
        if (
          req.query.nextauth?.includes('callback') &&
          req.query.nextauth?.includes('credentials') &&
          req.method === 'POST'
        ) {
          return null
        }
        // Revert to default behaviour when not in the credentials provider callback flow
        return decode({ token, secret })
      },
    },
    callbacks: {
      async signIn({ user, account, profile, email, credentials }) {
        const provider = account?.provider as 'google' | 'credentials'

        // Case provider is 'credentials', the authorize function will perform verification, so return true.
        // ?????????????????? 'credentials'??? ????????? authorize ???????????? ????????? ??????????????? true??? ????????????.
        if (provider === 'credentials') {
          const sessionToken = generateSessionToken()
          const sessionExpiry = fromDate(SESSION_MAXAGE)

          await adapter.createSession({
            sessionToken,
            userId: user.id,
            expires: sessionExpiry,
          })
          setCookie('next-auth.session-token', sessionToken, {
            expires: sessionExpiry,
            req,
            res,
            httpOnly: true,
          })

          return true
        }

        if (!account) return false
        // Case social login, check if there is a user, and if not, redirect to account page.
        // ?????????????????? ?????? ????????? ????????? ???????????? ????????? ???????????? ???????????? ???????????????.
        const findUser = await prisma.user.findUnique({
          where: { email: user.email || '' },
        })
        if (!findUser) return `?redirect_from=signin&${provider}=${user.email}`

        // Case first social login, create account (provider = google)
        // ?????????????????? ?????? ?????????????????? provider??? google??? ????????? ???????????????.
        const findAccount = await prisma.account.findFirst({
          where: {
            providerAccountId: account.providerAccountId,
            provider: account.provider,
            userId: findUser.id,
          },
        })
        if (!findAccount) {
          await prisma.account.create({
            data: { ...account, userId: findUser.id },
          })
          adapter.linkAccount(findAccount as any)
        }

        return true
      },
      async jwt({ token, user, account, profile, isNewUser }) {
        if (user) {
          token.id = user.id
        }
        return token
      },
      async session({ session, token, user }) {
        if (token) {
          session.id = token.id as string
        }
        session.user = { ...session.user, ...(user as PrismaUser) }
        return session
      },
    },
    providers: [
      // ?????? ?????????
      CredentialsProvider({
        name: 'Credentials',
        credentials: {
          email: {
            label: '?????????',
            type: 'text',
            placeholder: '???????????? ???????????????.',
          },
          password: {
            label: '????????????',
            type: 'password',
            placeholder: '??????????????? ???????????????.',
          },
        },
        authorize: async function authorize(credentials) {
          if (!credentials) return null

          const { email, password } = credentials
          const user = (await prisma.user.findUnique({
            where: { email },
          })) as PrismaUser | null

          if (!user) return null // ?????? ????????? ???????????? ??????

          const hashedPassword = user.pwd || '-1'

          const isMatch = await bcrypt.compare(password, hashedPassword)
          return isMatch ? user : null // ??????????????? ????????????????????? ??????
        },
      }),

      // ?????? ?????????
      GoogleProvider({
        clientId: process.env.GOOGLE_ID,
        clientSecret: process.env.GOOGLE_SECRET,
      }),
    ],
  })
}
