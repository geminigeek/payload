import type { Connect } from 'payload/database'

import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { numeric, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import prompts from 'prompts'

import type { PostgresAdapter } from './types'

export const connect: Connect = async function connect(this: PostgresAdapter, payload) {
  this.schema = {
    ...this.tables,
    ...this.relations,
    ...this.enums,
  }

  try {
    this.pool = new Pool(this.poolOptions)
    await this.pool.connect()

    this.drizzle = drizzle(this.pool, { schema: this.schema })
    if (process.env.PAYLOAD_DROP_DATABASE === 'true') {
      this.payload.logger.info('---- DROPPING TABLES ----')
      await this.drizzle.execute(sql`drop schema public cascade;
      create schema public;`)
      this.payload.logger.info('---- DROPPED TABLES ----')
    }
  } catch (err) {
    payload.logger.error(`Error: cannot connect to Postgres. Details: ${err.message}`, err)
    process.exit(1)
  }

  // Only push schema if not in production
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.PAYLOAD_MIGRATING === 'true' ||
    this.push === false
  )
    return

  const { pushSchema } = require('drizzle-kit/utils')

  // This will prompt if clarifications are needed for Drizzle to push new schema
  const { apply, hasDataLoss, statementsToExecute, warnings } = await pushSchema(
    this.schema,
    this.drizzle,
  )

  if (warnings.length) {
    let message = `Warnings detected during schema push: \n\n${warnings.join('\n')}\n\n`

    if (hasDataLoss) {
      message += `DATA LOSS WARNING: Possible data loss detected if schema is pushed.\n\n`
    }

    message += `Accept warnings and push schema to database?`

    const { confirm: acceptWarnings } = await prompts(
      {
        name: 'confirm',
        initial: false,
        message,
        type: 'confirm',
      },
      {
        onCancel: () => {
          process.exit(0)
        },
      },
    )

    // Exit if user does not accept warnings.
    // Q: Is this the right type of exit for this interaction?
    if (!acceptWarnings) {
      process.exit(0)
    }
  }

  await apply()

  // Migration table def in order to use query using drizzle
  const migrationsSchema = pgTable('payload_migrations', {
    name: varchar('name'),
    batch: numeric('batch'),
    created_at: timestamp('created_at'),
    updated_at: timestamp('updated_at'),
  })

  const devPush = await this.drizzle
    .select()
    .from(migrationsSchema)
    .where(eq(migrationsSchema.batch, '-1'))

  if (!devPush.length) {
    await this.drizzle.insert(migrationsSchema).values({
      name: 'dev',
      batch: '-1',
    })
  } else {
    await this.drizzle
      .update(migrationsSchema)
      .set({
        updated_at: new Date(),
      })
      .where(eq(migrationsSchema.batch, '-1'))
  }
}
