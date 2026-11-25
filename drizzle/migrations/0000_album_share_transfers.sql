CREATE TABLE public.album_shares (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 manifest jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.album_shares TO authenticated;
GRANT ALL ON public.album_shares TO service_role;
ALTER TABLE public.album_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read own album transfers" ON public.album_shares FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX album_shares_owner_idx ON public.album_shares (user_id);
CREATE TABLE public.album_share_parts (
 share_id uuid NOT NULL REFERENCES public.album_shares(id) ON DELETE CASCADE,
 part_index integer NOT NULL CHECK (part_index >= 0 AND part_index < 200),
 status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','complete')),
 file_id text,
 PRIMARY KEY (share_id, part_index)
);
GRANT SELECT ON public.album_share_parts TO authenticated;
GRANT ALL ON public.album_share_parts TO service_role;
ALTER TABLE public.album_share_parts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read own album parts" ON public.album_share_parts FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.album_shares s WHERE s.id = share_id AND s.user_id = auth.uid()));