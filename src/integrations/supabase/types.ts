export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ads_diario: {
        Row: {
          acos: number | null
          cliques: number | null
          conversoes: number | null
          conversoes_diretas: number | null
          cpc: number | null
          ctr: number | null
          data: string
          gasto: number | null
          gmv: number | null
          id: number
          impressoes: number | null
          itens_vendidos: number | null
          receita_direta: number | null
          roas: number | null
          shop_id: number | null
          sku: string | null
        }
        Insert: {
          acos?: number | null
          cliques?: number | null
          conversoes?: number | null
          conversoes_diretas?: number | null
          cpc?: number | null
          ctr?: number | null
          data: string
          gasto?: number | null
          gmv?: number | null
          id?: never
          impressoes?: number | null
          itens_vendidos?: number | null
          receita_direta?: number | null
          roas?: number | null
          shop_id?: number | null
          sku?: string | null
        }
        Update: {
          acos?: number | null
          cliques?: number | null
          conversoes?: number | null
          conversoes_diretas?: number | null
          cpc?: number | null
          ctr?: number | null
          data?: string
          gasto?: number | null
          gmv?: number | null
          id?: never
          impressoes?: number | null
          itens_vendidos?: number | null
          receita_direta?: number | null
          roas?: number | null
          shop_id?: number | null
          sku?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ads_diario_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "lojas"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      cmv_skus: {
        Row: {
          atualizado_em: string | null
          custo: number
          fonte: string | null
          sku: string
        }
        Insert: {
          atualizado_em?: string | null
          custo: number
          fonte?: string | null
          sku: string
        }
        Update: {
          atualizado_em?: string | null
          custo?: number
          fonte?: string | null
          sku?: string
        }
        Relationships: []
      }
      imports_log: {
        Row: {
          arquivo: string | null
          detalhes: Json | null
          finalizado_em: string | null
          id: number
          iniciado_em: string | null
          qtd_erros: number | null
          qtd_registros: number | null
          status: string | null
          tipo: string
        }
        Insert: {
          arquivo?: string | null
          detalhes?: Json | null
          finalizado_em?: string | null
          id?: never
          iniciado_em?: string | null
          qtd_erros?: number | null
          qtd_registros?: number | null
          status?: string | null
          tipo: string
        }
        Update: {
          arquivo?: string | null
          detalhes?: Json | null
          finalizado_em?: string | null
          id?: never
          iniciado_em?: string | null
          qtd_erros?: number | null
          qtd_registros?: number | null
          status?: string | null
          tipo?: string
        }
        Relationships: []
      }
      kits_composicao: {
        Row: {
          atualizado_em: string | null
          id: number
          nome_componente: string | null
          nome_kit: string | null
          quantidade: number
          sku_componente: string
          sku_kit: string
        }
        Insert: {
          atualizado_em?: string | null
          id?: never
          nome_componente?: string | null
          nome_kit?: string | null
          quantidade: number
          sku_componente: string
          sku_kit: string
        }
        Update: {
          atualizado_em?: string | null
          id?: never
          nome_componente?: string | null
          nome_kit?: string | null
          quantidade?: number
          sku_componente?: string
          sku_kit?: string
        }
        Relationships: []
      }
      lojas: {
        Row: {
          ativa: boolean | null
          cnpj: string | null
          criada_em: string | null
          id: number
          nome: string
          shop_id: number
        }
        Insert: {
          ativa?: boolean | null
          cnpj?: string | null
          criada_em?: string | null
          id?: never
          nome: string
          shop_id: number
        }
        Update: {
          ativa?: boolean | null
          cnpj?: string | null
          criada_em?: string | null
          id?: never
          nome?: string
          shop_id?: number
        }
        Relationships: []
      }
      oauth_tokens_shopee: {
        Row: {
          access_token: string
          atualizado_em: string | null
          expires_at: string
          partner_id: number
          refresh_expires_at: string
          refresh_token: string
          shop_id: number
        }
        Insert: {
          access_token: string
          atualizado_em?: string | null
          expires_at: string
          partner_id: number
          refresh_expires_at: string
          refresh_token: string
          shop_id: number
        }
        Update: {
          access_token?: string
          atualizado_em?: string | null
          expires_at?: string
          partner_id?: number
          refresh_expires_at?: string
          refresh_token?: string
          shop_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "oauth_tokens_shopee_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: true
            referencedRelation: "lojas"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      pedido_itens: {
        Row: {
          id: number
          nome_produto: string | null
          pedido_id: string | null
          quantidade: number | null
          sku_filho: string | null
          sku_pai: string | null
          subtotal_produto: number | null
        }
        Insert: {
          id?: never
          nome_produto?: string | null
          pedido_id?: string | null
          quantidade?: number | null
          sku_filho?: string | null
          sku_pai?: string | null
          subtotal_produto?: number | null
        }
        Update: {
          id?: never
          nome_produto?: string | null
          pedido_id?: string | null
          quantidade?: number | null
          sku_filho?: string | null
          sku_pai?: string | null
          subtotal_produto?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pedido_itens_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_itens_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "view_conciliacao"
            referencedColumns: ["pedido_id"]
          },
        ]
      }
      pedidos: {
        Row: {
          ajuste_acao_comercial: number | null
          atualizado_em: string | null
          cidade: string | null
          comissao_afiliados: number | null
          criado_em: string | null
          data_pagamento_shopee: string | null
          data_pedido: string
          fonte: string | null
          id: string
          imposto_estimado: number | null
          motivo_cancelamento: string | null
          opcao_envio: string | null
          primeiro_produto: string | null
          recebido_estimado: number | null
          renda_estimada: number | null
          shop_id: number | null
          status_pedido: string
          subtotal_bruto: number | null
          subtotal_produtos: number | null
          taxa_comissao: number | null
          taxa_servico: number | null
          taxa_transacao: number | null
          uf: string | null
          valido: boolean | null
        }
        Insert: {
          ajuste_acao_comercial?: number | null
          atualizado_em?: string | null
          cidade?: string | null
          comissao_afiliados?: number | null
          criado_em?: string | null
          data_pagamento_shopee?: string | null
          data_pedido: string
          fonte?: string | null
          id: string
          imposto_estimado?: number | null
          motivo_cancelamento?: string | null
          opcao_envio?: string | null
          primeiro_produto?: string | null
          recebido_estimado?: number | null
          renda_estimada?: number | null
          shop_id?: number | null
          status_pedido: string
          subtotal_bruto?: number | null
          subtotal_produtos?: number | null
          taxa_comissao?: number | null
          taxa_servico?: number | null
          taxa_transacao?: number | null
          uf?: string | null
          valido?: boolean | null
        }
        Update: {
          ajuste_acao_comercial?: number | null
          atualizado_em?: string | null
          cidade?: string | null
          comissao_afiliados?: number | null
          criado_em?: string | null
          data_pagamento_shopee?: string | null
          data_pedido?: string
          fonte?: string | null
          id?: string
          imposto_estimado?: number | null
          motivo_cancelamento?: string | null
          opcao_envio?: string | null
          primeiro_produto?: string | null
          recebido_estimado?: number | null
          renda_estimada?: number | null
          shop_id?: number | null
          status_pedido?: string
          subtotal_bruto?: number | null
          subtotal_produtos?: number | null
          taxa_comissao?: number | null
          taxa_servico?: number | null
          taxa_transacao?: number | null
          uf?: string | null
          valido?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "pedidos_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "lojas"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      produtos: {
        Row: {
          ativo: boolean | null
          atualizado_em: string | null
          categoria: string | null
          estoque: number | null
          nome: string | null
          preco: number | null
          shop_id: number | null
          sku: string
        }
        Insert: {
          ativo?: boolean | null
          atualizado_em?: string | null
          categoria?: string | null
          estoque?: number | null
          nome?: string | null
          preco?: number | null
          shop_id?: number | null
          sku: string
        }
        Update: {
          ativo?: boolean | null
          atualizado_em?: string | null
          categoria?: string | null
          estoque?: number | null
          nome?: string | null
          preco?: number | null
          shop_id?: number | null
          sku?: string
        }
        Relationships: [
          {
            foreignKeyName: "produtos_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "lojas"
            referencedColumns: ["shop_id"]
          },
        ]
      }
      transacoes_carteira: {
        Row: {
          classificacao: string
          criado_em: string | null
          data: string
          descricao: string | null
          direcao: string
          fonte: string | null
          id: number
          pedido_id: string | null
          saldo_apos: number | null
          shop_id: number | null
          shopee_transaction_id: string | null
          status: string | null
          tipo: string
          valor: number
        }
        Insert: {
          classificacao: string
          criado_em?: string | null
          data: string
          descricao?: string | null
          direcao: string
          fonte?: string | null
          id?: never
          pedido_id?: string | null
          saldo_apos?: number | null
          shop_id?: number | null
          shopee_transaction_id?: string | null
          status?: string | null
          tipo: string
          valor: number
        }
        Update: {
          classificacao?: string
          criado_em?: string | null
          data?: string
          descricao?: string | null
          direcao?: string
          fonte?: string | null
          id?: never
          pedido_id?: string | null
          saldo_apos?: number | null
          shop_id?: number | null
          shopee_transaction_id?: string | null
          status?: string | null
          tipo?: string
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "transacoes_carteira_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transacoes_carteira_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "view_conciliacao"
            referencedColumns: ["pedido_id"]
          },
          {
            foreignKeyName: "transacoes_carteira_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "lojas"
            referencedColumns: ["shop_id"]
          },
        ]
      }
    }
    Views: {
      view_cmv_efetivo: {
        Row: {
          cmv_efetivo: number | null
          detalhes: string | null
          sku: string | null
          tipo: string | null
        }
        Relationships: []
      }
      view_cmv_pedido: {
        Row: {
          cmv_total: number | null
          itens_sem_cmv: number | null
          pedido_id: string | null
          total_itens: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pedido_itens_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "pedidos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pedido_itens_pedido_id_fkey"
            columns: ["pedido_id"]
            isOneToOne: false
            referencedRelation: "view_conciliacao"
            referencedColumns: ["pedido_id"]
          },
        ]
      }
      view_conciliacao: {
        Row: {
          afiliados_carteira: number | null
          data_pagamento: string | null
          data_pedido: string | null
          opcao_envio: string | null
          pedido_id: string | null
          primeiro_produto: string | null
          rebate_carteira: number | null
          recebido_estimado: number | null
          renda_estimada: number | null
          status_pagamento: string | null
          status_pedido: string | null
          subtotal_produtos: number | null
          uf: string | null
          valor_recebido_shopee: number | null
          via_acelera: boolean | null
        }
        Insert: {
          afiliados_carteira?: never
          data_pagamento?: never
          data_pedido?: string | null
          opcao_envio?: string | null
          pedido_id?: string | null
          primeiro_produto?: string | null
          rebate_carteira?: never
          recebido_estimado?: number | null
          renda_estimada?: number | null
          status_pagamento?: never
          status_pedido?: string | null
          subtotal_produtos?: number | null
          uf?: string | null
          valor_recebido_shopee?: never
          via_acelera?: never
        }
        Update: {
          afiliados_carteira?: never
          data_pagamento?: never
          data_pedido?: string | null
          opcao_envio?: string | null
          pedido_id?: string | null
          primeiro_produto?: string | null
          rebate_carteira?: never
          recebido_estimado?: number | null
          renda_estimada?: number | null
          status_pagamento?: never
          status_pedido?: string | null
          subtotal_produtos?: number | null
          uf?: string | null
          valor_recebido_shopee?: never
          via_acelera?: never
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
