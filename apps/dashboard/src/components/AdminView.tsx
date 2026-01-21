"use client";

import { useState, useEffect } from "react";
import { client } from "@/lib/api";
import {
    Users,
    Key,
    Trash2,
    Plus,
    RefreshCcw,
    Shield,
    UserPlus,
    Check,
    Copy,
    AlertCircle
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { UserProfile, ApiKey } from "@/lib/types";

export function AdminView() {
    const [users, setUsers] = useState<UserProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [newUserId, setNewUserId] = useState("");
    const [showAddUser, setShowAddUser] = useState(false);
    const [selectedUser, setSelectedUser] = useState<string | null>(null);
    const [userKeys, setUserKeys] = useState<ApiKey[]>([]);
    const [keysLoading, setKeysLoading] = useState(false);

    const loadUsers = async () => {
        try {
            setLoading(true);
            // AdminClient methods are on client.admin
            const data = await client.admin.getUsers();
            setUsers(data);
        } catch (err) {
            console.error(err);
            toast.error("Failed to load users");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadUsers();
    }, []);

    useEffect(() => {
        if (selectedUser) {
            loadUserKeys(selectedUser);
        } else {
            setUserKeys([]);
        }
    }, [selectedUser]);

    const loadUserKeys = async (userId: string) => {
        try {
            setKeysLoading(true);
            const keys = await client.admin.getUserKeys(userId);
            setUserKeys(keys);
        } catch (err) {
            console.error(err);
            toast.error("Failed to load API keys");
        } finally {
            setKeysLoading(false);
        }
    };

    const handleCreateUser = async () => {
        if (!newUserId) return;
        try {
            await client.admin.createUser(newUserId);
            toast.success(`User ${newUserId} created`);
            setNewUserId("");
            setShowAddUser(false);
            loadUsers();
        } catch (err) {
            toast.error("Failed to create user");
        }
    };

    const handleDeleteUser = async (userId: string) => {
        if (!confirm(`Permanently delete user ${userId} and ALL their data?`)) return;
        try {
            await client.admin.deleteUser(userId);
            toast.success("User deleted");
            if (selectedUser === userId) setSelectedUser(null);
            loadUsers();
        } catch (err) {
            toast.error("Delete failed");
        }
    };

    const handleCreateKey = async (userId: string) => {
        const note = prompt("Enter a note for this key:");
        if (note === null) return;
        try {
            const res = await client.admin.createKey(userId, "user", note);
            toast.success("API Key generated");
            // Show the key to the user since it's only shown once
            alert(`New API Key (copy now, it won't be shown again):\n\n${res.key}`);
            loadUserKeys(userId);
        } catch (err) {
            toast.error("Failed to generate key");
        }
    };

    const handleRevokeKey = async (hash: string) => {
        if (!confirm("Revoke this API key?")) return;
        try {
            await client.admin.deleteKey(hash);
            toast.success("Key revoked");
            if (selectedUser) loadUserKeys(selectedUser);
        } catch (err) {
            toast.error("Revoke failed");
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        toast.success("Copied to clipboard");
    };

    return (
        <div className="flex flex-col gap-8">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <div className="p-2.5 bg-primary/10 rounded-xl text-primary">
                        <Users size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-black text-white uppercase tracking-tight">Identity Management</h2>
                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">Control access and user scopes</p>
                    </div>
                </div>
                <button
                    onClick={() => setShowAddUser(!showAddUser)}
                    className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-xl text-sm font-bold hover:bg-primary/90 transition-all active:scale-95 shadow-lg shadow-primary/20"
                >
                    <UserPlus size={16} />
                    Provision User
                </button>
            </div>

            {showAddUser && (
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 p-6 glass-card border-primary/20 animate-in slide-in-from-top-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-[10px] font-black uppercase text-zinc-500 tracking-widest">New System Identity (User ID)</label>
                        <input
                            type="text"
                            value={newUserId}
                            onChange={(e) => setNewUserId(e.target.value)}
                            className="bg-black/40 border border-white/10 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-primary/50 transition-colors"
                            placeholder="e.g. agent_alpha_01"
                        />
                    </div>
                    <div className="flex items-end gap-3">
                        <button
                            onClick={() => setShowAddUser(false)}
                            className="px-4 py-3 text-xs font-bold text-zinc-400 hover:text-white transition-colors uppercase tracking-widest"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreateUser}
                            className="px-6 py-3 bg-white text-black rounded-xl text-xs font-black uppercase tracking-widest hover:bg-zinc-200 transition-all active:scale-95"
                        >
                            Initialize
                        </button>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                {/* User List */}
                <div className="lg:col-span-12 xl:col-span-5 flex flex-col gap-4">
                    <div className="text-[10px] font-black uppercase text-zinc-600 tracking-[0.2em] mb-2 px-1">Active Identities</div>
                    {loading ? (
                        <div className="p-12 glass-card flex items-center justify-center">
                            <RefreshCcw size={20} className="animate-spin text-primary" />
                        </div>
                    ) : users.length === 0 ? (
                        <div className="p-12 glass-card border-dashed border-white/10 text-center">
                            <p className="text-sm text-zinc-500 italic">No users provisioned.</p>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {users.map((u) => (
                                <div
                                    key={u.id}
                                    onClick={() => setSelectedUser(u.id)}
                                    className={cn(
                                        "p-4 glass-card border-white/5 flex items-center justify-between group transition-all cursor-pointer hover:border-white/20",
                                        selectedUser === u.id ? "border-primary/40 bg-primary/5 shadow-lg shadow-primary/5" : ""
                                    )}
                                >
                                    <div className="flex items-center gap-4">
                                        <div className={cn(
                                            "w-10 h-10 rounded-full flex items-center justify-center font-black text-xs transition-colors",
                                            selectedUser === u.id ? "bg-primary text-white" : "bg-zinc-900 text-zinc-500 group-hover:bg-zinc-800"
                                        )}>
                                            {u.id.substring(0, 2).toUpperCase()}
                                        </div>
                                        <div>
                                            <h4 className="font-bold text-white text-sm tracking-tight">{u.id}</h4>
                                            <p className="text-[10px] text-zinc-500 font-medium uppercase mt-0.5">
                                                Created {new Date(u.createdAt).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {selectedUser === u.id && <Check size={16} className="text-primary" />}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteUser(u.id); }}
                                            className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Key Management */}
                <div className="lg:col-span-12 xl:col-span-7 flex flex-col gap-4">
                    <div className="text-[10px] font-black uppercase text-zinc-600 tracking-[0.2em] mb-2 px-1">
                        {selectedUser ? `Access Credentials for ${selectedUser}` : "Select a user to manage credentials"}
                    </div>

                    {!selectedUser ? (
                        <div className="p-20 glass-card border-dashed border-white/10 flex flex-col items-center justify-center text-center opacity-50">
                            <Shield size={48} className="text-zinc-700 mb-4" />
                            <p className="text-sm text-zinc-500 font-medium italic">Select an identity from the list to manage API keys.</p>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-6 animate-in fade-in duration-500">
                            <div className="flex items-center justify-between px-2">
                                <p className="text-xs text-zinc-400 font-medium max-w-sm">
                                    API keys provide direct access to this system scope. Treat them as sensitive passwords.
                                </p>
                                <button
                                    onClick={() => handleCreateKey(selectedUser)}
                                    className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all active:scale-95"
                                >
                                    <Key size={14} />
                                    Mint New Key
                                </button>
                            </div>

                            {keysLoading ? (
                                <div className="p-12 glass-card flex items-center justify-center">
                                    <RefreshCcw size={20} className="animate-spin text-primary" />
                                </div>
                            ) : userKeys.length === 0 ? (
                                <div className="p-12 glass-card border-dashed border-white/10 text-center">
                                    <AlertCircle size={24} className="mx-auto mb-3 text-zinc-700" />
                                    <p className="text-sm text-zinc-500 italic">No keys active for this identity.</p>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-4">
                                    {userKeys.map((k) => (
                                        <div key={k.id} className="p-5 glass-card border-white/5 flex flex-col gap-4 group hover:border-zinc-700 transition-colors">
                                            <div className="flex items-start justify-between">
                                                <div className="flex items-center gap-3">
                                                    <div className="p-2 bg-zinc-900 rounded-lg text-zinc-500">
                                                        <Key size={16} />
                                                    </div>
                                                    <div>
                                                        <h5 className="text-sm font-bold text-white mb-0.5">{k.description || "Unlabeled Access Key"}</h5>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[9px] font-black uppercase bg-primary/10 text-primary px-1.5 py-0.5 rounded leading-none">{k.scopes?.[0] || "user"}</span>
                                                            <span className="text-[9px] font-mono text-zinc-600">ID: {k.id.substring(0, 12)}...</span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => handleRevokeKey(k.id)}
                                                    className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-all"
                                                    title="Revoke Key"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
                                                <div>
                                                    <p className="text-[9px] font-black uppercase text-zinc-600 tracking-widest mb-1">Status</p>
                                                    <div className="flex items-center gap-1.5">
                                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                                                        <p className="text-[10px] font-bold text-zinc-300 uppercase tracking-tight">Active</p>
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="text-[9px] font-black uppercase text-zinc-600 tracking-widest mb-1">Last Used</p>
                                                    <p className="text-[10px] font-bold text-zinc-300 uppercase tracking-tight">
                                                        {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
