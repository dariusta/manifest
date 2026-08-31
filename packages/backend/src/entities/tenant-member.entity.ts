import { Entity, Column, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

export type TenantMemberRole = 'admin' | 'member';

/**
 * Additional users granted access to a tenant (workspace). The tenant's
 * creator is NOT stored here — ownership stays on `tenants.owner_user_id`
 * and resolution treats it as an implicit 'owner' membership, so existing
 * single-user tenants need no backfill.
 */
@Entity('tenant_members')
@Index(['user_id'])
export class TenantMember {
  @PrimaryColumn('varchar')
  tenant_id!: string;

  @PrimaryColumn('varchar')
  user_id!: string;

  @Column('varchar', { default: 'member' })
  role!: TenantMemberRole;

  @Column('varchar', { nullable: true })
  added_by_user_id!: string | null;

  @Column(timestampType(), { default: timestampDefault() })
  created_at!: string;
}
