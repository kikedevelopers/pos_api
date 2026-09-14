import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Enlace de recuperación de contraseña enviado por correo.
 *
 * Se guarda el SHA-256 del token, NUNCA el valor en claro: quien lea la tabla
 * no puede tomar el control de ninguna cuenta. De un solo uso (`used_at`) y con
 * una caducidad corta — este token permite cambiar la contraseña de una cuenta
 * viva, así que cuanto menos tiempo exista, mejor.
 */
@Entity('password_reset_tokens')
export class PasswordResetToken {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  /** SHA-256 en hexadecimal del token que viajó en el correo. */
  @Column({ type: 'text' })
  token_hash!: string;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  /** Momento del canje. NULL = todavía sirve. */
  @Column({ type: 'timestamptz', nullable: true })
  used_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
